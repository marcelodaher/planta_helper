import { FACADES, GRID, MAX_ASPECT, MIN_DOOR, OBJECTIVES, bounds, cells, contactGraph, touchesExterior, validateLayout, validateLoose } from "./layout.mjs";
import { collectLoose } from "./engines.mjs";

// Load the solver on first use: a module worker cannot resolve the bare "cp-sat-wasm"
// specifier (import maps do not reach workers), so the browser build is the fallback there.
let solverModule = null;
function solver() {
  solverModule ??= import("cp-sat-wasm").catch(() =>
    import("./node_modules/cp-sat-wasm/build/javascript/browser/cp-sat.js"));
  return solverModule;
}

// The wasm executor runs one job at a time per process and throws on overlap; concurrent
// callers queue instead. The page never hits this: each objective gets its own worker.
let solverTail = Promise.resolve();
function queuedSolve(CpSat, model, options) {
  const run = solverTail.then(() => CpSat.solve(model, options));
  solverTail = run.catch(() => {});
  return run;
}

// Time limit per objective: the solver always spends the whole budget unless it proves
// optimality, so the cap is the page's wait, not the search's difficulty. Tests shorten it.
const SOLVE_MAX_SECONDS = 8;
const SOLVE_MIN_SECONDS = 3;
function solveSeconds(rooms) {
  const override = Number(globalThis.process?.env?.PLANTA_SOLVE_SECONDS);
  return override || Math.min(SOLVE_MAX_SECONDS, Math.max(SOLVE_MIN_SECONDS, rooms.length * 0.6));
}

// Box of a layout, in cells.
function layoutBox(layout) {
  return layout.reduce((box, room) => ({
    minX: Math.min(box.minX, room.x),
    minY: Math.min(box.minY, room.y),
    maxX: Math.max(box.maxX, room.x + room.w),
    maxY: Math.max(box.maxY, room.y + room.h),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

// Seed the model with a known layout; coordinates are rotated and shifted into the origin.
// Rotation is skipped when rooms need named facades, since the compass then matters.
function applyHint(model, variables, exteriorWidth, exteriorHeight, limit, hint, oriented = false) {
  if (!hint?.layout?.length) return;
  const raw = layoutBox(hint.layout);
  const tall = raw.maxY - raw.minY > raw.maxX - raw.minX;
  const layout = tall && !oriented
    ? hint.layout.map(room => ({ ...room, x: room.y, y: room.x, w: room.h, h: room.w }))
    : hint.layout;
  const box = layoutBox(layout);
  const clamp = (value, low) => Math.max(low, Math.min(limit, Math.round(value)));
  for (const placed of layout) {
    const room = variables.find(candidate => candidate.name === placed.room);
    if (!room) continue;
    const min = Math.ceil(room.minSide * GRID);
    model.addHint(room.x, clamp(placed.x - box.minX, 0));
    model.addHint(room.y, clamp(placed.y - box.minY, 0));
    model.addHint(room.width, clamp(placed.w, min));
    model.addHint(room.height, clamp(placed.h, min));
  }
  model.addHint(exteriorWidth, clamp(box.maxX - box.minX, 1));
  model.addHint(exteriorHeight, clamp(box.maxY - box.minY, 1));
}

// Four bools, one per side, true when `a` shares at least MIN_DOOR of wall with `b`.
function touchBools(model, a, b, limit, tag) {
  const directions = ["left", "right", "above", "below"];
  const bools = directions.map(direction => model.newBoolVar(`${a.name}_${b.name}_${tag}_${direction}`));
  const touch = (direction, firstStart, firstEnd, secondStart, secondEnd) => {
    const bool = bools[directions.indexOf(direction)];
    const overlapStart = model.newIntVar(0, limit, `${a.name}_${b.name}_${tag}_${direction}_start`);
    const overlapEnd = model.newIntVar(0, limit, `${a.name}_${b.name}_${tag}_${direction}_end`);
    model.addMaxEquality(overlapStart, [firstStart, secondStart]).onlyEnforceIf(bool);
    model.addMinEquality(overlapEnd, [firstEnd, secondEnd]).onlyEnforceIf(bool);
    model.add(overlapEnd.ge(overlapStart.plus(MIN_DOOR))).onlyEnforceIf(bool);
  };
  model.add(a.endX.eq(b.x)).onlyEnforceIf(bools[0]);
  touch("left", a.y, a.endY, b.y, b.endY);
  model.add(b.endX.eq(a.x)).onlyEnforceIf(bools[1]);
  touch("right", a.y, a.endY, b.y, b.endY);
  model.add(a.endY.eq(b.y)).onlyEnforceIf(bools[2]);
  touch("above", a.x, a.endX, b.x, b.endX);
  model.add(b.endY.eq(a.y)).onlyEnforceIf(bools[3]);
  touch("below", a.x, a.endX, b.x, b.endX);
  return bools;
}

// Connected rooms must share exactly one wall with room for a door.
function enforceTouch(model, a, b, limit) {
  model.addExactlyOne(touchBools(model, a, b, limit, "link"));
}

// Side-range implied by the room limits and the aspect cap. Every bound below holds for
// any feasible plan, so narrowing the domains can prune but never remove a solution.
function sideRange(rooms, loose) {
  const minArea = rooms.reduce((sum, room) => sum + cells(room.minArea), 0);
  const maxArea = rooms.reduce((sum, room) => sum + cells(room.maxArea), 0);
  // Tight: the footprint is W·H = A ∈ [Σmin, Σmax] and W ≤ MAX_ASPECT·H, so both sides
  // sit in [√(Σmin/MAX_ASPECT), √(MAX_ASPECT·Σmax)]. Loose: only W·H ≥ Σmin is implied.
  const low = Math.max(1, Math.ceil(Math.sqrt(minArea / MAX_ASPECT)));
  const high = loose ? maxArea : Math.min(maxArea, Math.floor(Math.sqrt(maxArea * MAX_ASPECT)));
  return { minArea, maxArea, low, high: Math.max(low, high) };
}

// Interchangeable rooms (same limits, links and flags) are ordered by x+y; the constraint
// drops mirror-image duplicates without cutting a topology.
function breakSymmetry(model, variables) {
  const key = room => JSON.stringify([room.minArea, room.maxArea, room.minSide, room.links, room.facades, room.exterior, room.corridor, room.void]);
  const groups = new Map();
  for (const room of variables) groups.set(key(room), [...(groups.get(key(room)) ?? []), room]);
  for (const group of groups.values()) {
    for (let index = 1; index < group.length; index++) {
      const [before, after] = [group[index - 1], group[index]];
      model.add(before.x.plus(before.y).le(after.x.plus(after.y)));
    }
  }
}

// Build an exact grid model: rooms fit one exterior rectangle without overlap.
// A tight model tiles the rectangle; a loose model leaves open space inside it.
// A pinned `box` turns the exterior sides into constants and `objective` null makes the
// model a pure tiling decision — both far easier for the solver than a free optimization.
function buildModel(CpModel, LinearExpr, rooms, objective, loose = false, box = null) {
  const model = new CpModel();
  const { minArea, maxArea, low, high } = sideRange(rooms, loose);
  const maximumSide = high;
  const exteriorWidth = model.newIntVar(box?.width ?? low, box?.width ?? high, "exterior_width");
  const exteriorHeight = model.newIntVar(box?.height ?? low, box?.height ?? high, "exterior_height");
  const footprint = model.newIntVar(minArea, maxArea, "footprint");
  model.addMultiplicationEquality(footprint, [exteriorWidth, exteriorHeight]);
  // A rotated layout is equivalent unless a room needs a named facade; then the compass matters.
  const oriented = rooms.some(room => room.facades?.length);
  if (oriented) {
    model.add(exteriorWidth.le(exteriorHeight.times(MAX_ASPECT)));
    model.add(exteriorHeight.le(exteriorWidth.times(MAX_ASPECT)));
  } else {
    // Keeping the wider side fixed removes half the symmetry.
    model.add(exteriorWidth.ge(exteriorHeight));
    // Cap the aspect ratio: without it "biggest area" degenerates into a long corridor house.
    model.add(exteriorWidth.le(exteriorHeight.times(MAX_ASPECT)));
  }

  const variables = rooms.map(room => {
    const min = Math.ceil(room.minSide * GRID);
    // area = w·h ≤ maxArea with h ≥ min, so neither side can pass maxArea/min.
    const widest = Math.max(min, Math.min(maximumSide, Math.floor(cells(room.maxArea) / min)));
    const width = model.newIntVar(min, widest, `${room.name}_width`);
    const height = model.newIntVar(min, widest, `${room.name}_height`);
    const area = model.newIntVar(cells(room.minArea), cells(room.maxArea), `${room.name}_area`);
    const x = model.newIntVar(0, Math.max(0, maximumSide - min), `${room.name}_x`);
    const y = model.newIntVar(0, Math.max(0, maximumSide - min), `${room.name}_y`);
    const endX = model.newIntVar(min, maximumSide, `${room.name}_end_x`);
    const endY = model.newIntVar(min, maximumSide, `${room.name}_end_y`);
    model.addMultiplicationEquality(area, [width, height]);
    model.addEquality(endX, x.plus(width));
    model.addEquality(endY, y.plus(height));
    model.add(endX.le(exteriorWidth));
    model.add(endY.le(exteriorHeight));
    return { ...room, width, height, area, x, y, endX, endY };
  });

  model.addNoOverlap2D(
    variables.map(room => model.newIntervalVar(room.x, room.width, room.endX, `${room.name}_x_interval`)),
    variables.map(room => model.newIntervalVar(room.y, room.height, room.endY, `${room.name}_y_interval`)),
  );
  breakSymmetry(model, variables);
  const roomArea = LinearExpr.sum(variables.map(room => room.area));
  if (loose) model.add(footprint.ge(roomArea));
  else model.addEquality(footprint, roomArea);

  for (const room of variables) {
    if (!room.exterior) continue;
    const sides = ["left", "top", "right", "bottom"].map(side => model.newBoolVar(`${room.name}_${side}`));
    model.add(room.x.eq(0)).onlyEnforceIf(sides[0]);
    model.add(room.y.eq(0)).onlyEnforceIf(sides[1]);
    model.add(room.endX.eq(exteriorWidth)).onlyEnforceIf(sides[2]);
    model.add(room.endY.eq(exteriorHeight)).onlyEnforceIf(sides[3]);
    // Touching an open void also counts as contact with the external area.
    const voidSides = variables
      .filter(peer => peer.void && peer.name !== room.name)
      .flatMap(peer => touchBools(model, room, peer, maximumSide, "void"));
    model.addBoolOr([...sides, ...voidSides]);
  }

  // A named facade pins that side of the room to the matching wall of the house.
  for (const room of variables) {
    for (const facade of room.facades ?? []) {
      if (facade === "north") model.add(room.y.eq(0));
      else if (facade === "south") model.add(room.endY.eq(exteriorHeight));
      else if (facade === "west") model.add(room.x.eq(0));
      else model.add(room.endX.eq(exteriorWidth));
    }
  }

  for (const room of variables) {
    for (const peer of room.links) {
      if (room.name > peer) continue;
      enforceTouch(model, room, variables.find(other => other.name === peer), maximumSide);
    }
  }

  const corridorArea = LinearExpr.sum(variables.filter(room => room.corridor).map(room => room.area));
  const tieBreaker = rooms.filter(room => room.corridor).reduce((sum, room) => sum + cells(room.maxArea), 0) + 1;
  // A loose layout may leave open space, so its useful area is the rooms, not the rectangle.
  const area = loose ? roomArea : footprint;
  if (objective === "min") model.minimize(footprint.times(tieBreaker).plus(corridorArea));
  if (objective === "max") model.maximize(area.times(tieBreaker).minus(corridorArea).minus(loose ? footprint : 0));
  if (objective === "corridor") model.minimize(corridorArea.times(maxArea + 1).minus(area).plus(loose ? footprint : 0));
  return { model, variables, exteriorWidth, exteriorHeight, limit: maximumSide };
}

// Exact engine: CP-SAT proves the best layout or reports the best one found.
async function cpSatSolve(rooms, objective, { loose = false, hint = null, seconds = solveSeconds(rooms), box = null } = {}) {
  const { CpModel, CpSat, LinearExpr } = await solver();
  const { model, variables, exteriorWidth, exteriorHeight, limit } = buildModel(CpModel, LinearExpr, rooms, objective, loose, box);
  applyHint(model, variables, exteriorWidth, exteriorHeight, limit, hint, rooms.some(room => room.facades?.length));
  // Node already uses every core; a pinned worker count exists for reproducible benches.
  const workers = Number(globalThis.process?.env?.PLANTA_WORKERS);
  const result = await queuedSolve(CpSat, model, {
    executor: "worker",
    maxTimeInSeconds: seconds,
    ...(workers ? { numWorkers: workers } : {}),
  });
  if (!result.hasSolution) return { status: result.statusName().toLowerCase(), layout: null };
  return {
    status: result.statusName().toLowerCase(),
    layout: variables.map(room => ({
      room: room.name,
      color: room.color,
      x: Number(result.value(room.x)),
      y: Number(result.value(room.y)),
      w: Number(result.value(room.width)),
      h: Number(result.value(room.height)),
    })),
    // The exterior rectangle may be larger than the rooms when the model is loose.
    bounds: {
      minX: 0,
      minY: 0,
      maxX: Number(result.value(exteriorWidth)),
      maxY: Number(result.value(exteriorHeight)),
    },
  };
}

// The largest house by box enumeration: the footprint is W·H = Σárea ≤ Σmax, so any
// tiling of a W·H = Σmax box is the proven maximum area — no optimization run can beat
// the ceiling. Squarest boxes first: a box that tiles decides in seconds, one that
// cannot stalls, so each box gets a share of the budget and the first answer wins.
// When no box tiles, the caller falls back to the free-box model: the true optimum can
// sit below Σmax when the Σmax rectangle itself cannot be tiled by the rooms.
// The corridor tie-break is left unoptimized: the box is chosen for area, not for it.
async function maxByBoxes(rooms, hint, seconds) {
  const { maxArea, low, high } = sideRange(rooms, false);
  const oriented = rooms.some(room => room.facades?.length);
  const boxes = [];
  for (let width = low; width <= Math.min(high, Math.floor(maxArea / low)); width++) {
    if (maxArea % width) continue;
    const height = maxArea / width;
    if (height < low || height > high) continue;
    if (width > MAX_ASPECT * height || height > MAX_ASPECT * width) continue;
    if (!oriented && width < height) continue;
    boxes.push({ width, height });
  }
  boxes.sort((a, b) => Math.abs(a.width - a.height) - Math.abs(b.width - b.height));
  const tries = Math.min(boxes.length, Math.max(1, Math.floor(seconds / 1.5)));
  for (const box of boxes.slice(0, tries)) {
    const result = await cpSatSolve(rooms, null, { box, hint, seconds: Math.max(1.5, seconds / tries) });
    if (result.layout) return { ...result, status: "optimal" };
  }
  return { status: "unknown", layout: null };
}

const cpSatEngine = {
  id: "cp-sat",
  label: "CP-SAT",
  description: "Busca exata; pode comprovar o ótimo, mas demora mais.",
  exact: true,
  validate: validateLayout,
  solve: async (rooms, objective, hint) => {
    if (objective !== "max") return cpSatSolve(rooms, objective, { hint });
    // Boxes first (proven ceiling); if none tiles, the free-box model hunts the optimum
    // that sits below Σmax — at the cost of a second budget on this objective alone.
    const boxed = await maxByBoxes(rooms, hint, solveSeconds(rooms));
    return boxed.layout ? boxed : cpSatSolve(rooms, objective, { hint });
  },
};

// Loose engine merged into one: the exact loose model answers (a rectangle with open
// space), the walk is the guaranteed floor, and no- answer carries the solver's verdict.
export const looseEngine = {
  id: "loose",
  label: "Livre",
  description: "Formatos em L ou irregulares: modelo exato com espaços livres e a caminhada heurística como resposta garantida.",
  exact: true,
  validate: validateLoose,
  solve: async (rooms, objective, hint) => {
    const budget = solveSeconds(rooms);
    if (objective === "max") {
      // A tight Σmax tiling is also the best loose plan, and the boxes prove it fast.
      const boxed = await maxByBoxes(rooms, hint, budget);
      if (boxed.layout) return boxed;
    }
    const exact = await cpSatSolve(rooms, objective, { loose: true, hint, seconds: budget });
    if (exact.layout && validateLoose(exact.layout, rooms) === "") return exact;
    const [walked] = collectLoose(rooms, objective);
    if (walked) return { status: "loose", layout: walked };
    // A solver plant our own validator rejects is not an answer: never echo its "feasible".
    return { status: exact.layout ? "failed" : exact.status, layout: null };
  },
};

export const engines = {
  "cp-sat": cpSatEngine,
  loose: looseEngine,
};

export const engineList = Object.values(engines);

// Add the room flags and bounding box the page needs.
function annotate(layout, rooms, boundsBox) {
  // Carry the void flag so touchesExterior can treat open areas as outside.
  const flags = new Map(rooms.map(room => [room.name, Boolean(room.void)]));
  const merged = layout.map(room => ({ ...room, void: flags.get(room.room) ?? false }));
  return {
    layout: merged.map(room => ({ ...room, touchesExterior: touchesExterior(room, merged) })),
    // Heuristic engines do not report an exterior rectangle; use the rooms' bounding box.
    bounds: boundsBox ?? bounds(merged),
  };
}

// Keep only box-shaped entries of a persisted warm start: storage can hold anything.
function usableWarm(warm, rooms) {
  if (!Array.isArray(warm)) return null;
  const boxes = warm.slice(0, rooms.length).filter(room => room && typeof room.room === "string" &&
    [room.x, room.y, room.w, room.h].every(Number.isInteger));
  return boxes.length ? boxes : null;
}

// Run one engine, then validate and annotate the layout.
// Seeds are tried in order until one engine run returns a layout; a time-limited exact run
// that finds nothing hands the card back to the walk, which already validated a plant.
// A warm start is a hint only, and only for the exact engines: the heuristic would echo it.
async function finalize(engine, rooms, objective, seeds = [], warm = null) {
  const hint = engine.exact ? usableWarm(warm, rooms) : null;
  let result = await engine.solve(rooms, objective, hint ? { layout: hint } : seeds[0] ?? null);
  for (const seed of seeds.slice(1)) {
    if (result.layout) break;
    result = await engine.solve(rooms, objective, seed);
  }
  const { status, layout, bounds: box } = result;
  const asWalk = () => {
    const walked = seeds.map(seed => seed?.layout).find(candidate => candidate && validateLoose(candidate, rooms) === "");
    return walked ? { status: "loose", engine: looseEngine.id, ...annotate(walked, rooms) } : null;
  };
  if (!layout) return asWalk() ?? { status, layout: null };
  const error = engine.validate(layout, rooms);
  if (error) return asWalk() ?? { status: "failed", layout: null, error };
  return { status, ...annotate(layout, rooms, box) };
}

// Whole-house area: the exterior rectangle when the engine reports one, else the rooms.
const optionArea = option => option.bounds
  ? (option.bounds.maxX - option.bounds.minX) * (option.bounds.maxY - option.bounds.minY)
  : option.layout.reduce((sum, room) => sum + room.w * room.h, 0);

// Alternatives: the loose walk is the shared store of different plan topologies.
const ALTERNATIVES_BUDGET = 150;
const MAX_ALTERNATIVES = 24;

// Round-robin the walk's other topologies across objectives, skipping any graph
// already shown as one of the three best options.
function gallery(options, found, rooms) {
  const seen = new Set(options.filter(option => option.layout).map(option => contactGraph(option.layout)));
  const longest = Math.max(0, ...[...found.values()].map(layouts => layouts.length));
  const picked = [];
  for (let index = 0; index < longest && picked.length < MAX_ALTERNATIVES; index++) {
    for (const [objective, layouts] of found) {
      const layout = layouts[index];
      if (!layout) continue;
      const graph = contactGraph(layout);
      if (seen.has(graph)) continue;
      seen.add(graph);
      picked.push({ objective, layout });
      if (picked.length >= MAX_ALTERNATIVES) break;
    }
  }
  return picked.map(({ objective, layout }, index) => ({
    id: `alt_${index + 1}`,
    label: `Alternativa · ${OBJECTIVES.find(item => item.id === objective)?.label ?? objective}`,
    objective,
    // The plant comes from the loose walk, whatever engine produced the main options.
    engine: looseEngine.id,
    status: "loose",
    ...annotate(layout, rooms),
  }));
}

// One objective on its own: the loose walk seeds the engine and feeds the gallery, so a
// worker can run a whole objective without touching the other two.
// `warm` is the plant this objective returned last time; it only hints the exact engines.
export async function solveObjective(rooms, objectiveId, engineId, warm = null) {
  const objective = OBJECTIVES.find(item => item.id === objectiveId) ?? OBJECTIVES[0];
  const chosen = engines[engineId] ?? cpSatEngine;
  const candidates = collectLoose(rooms, objective.key, ALTERNATIVES_BUDGET);
  const seeds = candidates[0] ? [{ layout: candidates[0] }] : [];
  const option = {
    id: objective.id,
    label: objective.label,
    engine: chosen.id,
    ...(await finalize(chosen, rooms, objective.key, seeds, warm)),
  };
  return { option, candidates };
}

// Walk-only plants for the page's first paint: the walk is fast (well under a second per
// objective), so the preview needs no solver and cannot be lost to a worker protocol. The
// exact answer replaces it in place; an objective the walk cannot place stays "pending".
export function walkPreviews(rooms) {
  return OBJECTIVES.map(objective => {
    const [layout] = collectLoose(rooms, objective.key, ALTERNATIVES_BUDGET);
    return {
      option: {
        id: objective.id,
        label: objective.label,
        engine: looseEngine.id,
        status: layout ? "preview" : "pending",
        ...(layout ? annotate(layout, rooms) : { layout: null }),
      },
      candidates: [],
    };
  });
}

// Merge per-objective results in objective order, then the alternatives gallery.
export function assemble(results, rooms) {
  const options = results.map(result => result.option);
  // Keep "menor" no larger than "maior" even when a heuristic finds both.
  const [smallest, largest] = [options[0], options[1]];
  if (smallest?.layout && largest?.layout && optionArea(smallest) > optionArea(largest)) {
    options[0] = { ...smallest, layout: largest.layout, bounds: largest.bounds, status: largest.status, engine: largest.engine };
    options[1] = { ...largest, layout: smallest.layout, bounds: smallest.bounds, status: smallest.status, engine: smallest.engine };
  }
  const found = new Map(OBJECTIVES.map((objective, index) => [objective.id, results[index]?.candidates ?? []]));
  return { options, alternatives: gallery(options, found, rooms) };
}

// Sequential path: CLI, tests, and the page when workers are unavailable.
export async function generateOptions({ rooms, engine = "cp-sat", warm = {} }) {
  const results = [];
  for (const objective of OBJECTIVES) results.push(await solveObjective(rooms, objective.id, engine, warm?.[objective.id]));
  return assemble(results, rooms);
}

export function validate(rooms) {
  if (!Array.isArray(rooms)) return "rooms precisa ser uma lista.";
  if (!rooms.length || rooms.some(room => !room || typeof room.name !== "string" || !room.name.trim())) return "Informe o nome de todos os cômodos.";
  const names = new Set(rooms.map(room => room.name));
  if (names.size !== rooms.length) return "Os nomes dos cômodos precisam ser únicos.";
  for (const room of rooms) {
    if (!Array.isArray(room.links)) return `links precisa ser uma lista em ${room.name}.`;
    if (room.exterior !== undefined && typeof room.exterior !== "boolean") return `exterior precisa ser booleano em ${room.name}.`;
    if (room.void !== undefined && typeof room.void !== "boolean") return `void precisa ser booleano em ${room.name}.`;
    if (room.corridor !== undefined && typeof room.corridor !== "boolean") return `corridor precisa ser booleano em ${room.name}.`;
    if (room.color !== undefined && !["green", "blue", "yellow", "orange", "purple", "pink", "gray"].includes(room.color)) return `Cor inválida em ${room.name}.`;
    if (room.facades !== undefined) {
      if (!Array.isArray(room.facades)) return `facades precisa ser uma lista em ${room.name}.`;
      if (room.facades.some(facade => !Object.hasOwn(FACADES, facade))) return `Fachada inválida em ${room.name}.`;
      if (new Set(room.facades).size !== room.facades.length) return `Fachada repetida em ${room.name}.`;
    }
    if (!Number.isFinite(room.minSide) || room.minSide <= 0) return `Confira a dimensão mínima de ${room.name}.`;
    if (!Number.isFinite(room.minArea) || !Number.isFinite(room.maxArea) || room.minArea <= 0 || room.maxArea < room.minArea) return `Confira as áreas de ${room.name}.`;
    if (room.links.some(name => !names.has(name) || name === room.name)) return `Conexão inválida em ${room.name}.`;
  }
  for (const room of rooms) {
    for (const name of room.links) {
      const peer = rooms.find(other => other.name === name);
      if (!peer.links.includes(room.name)) return `A conexão entre ${room.name} e ${name} precisa ser informada nos dois cômodos.`;
    }
  }
  return "";
}

// Normalize and validate a request; shared by the page, its workers and the CLI.
// `warm` (plant of the previous generation, per objective) is untrusted: keep only
// box-shaped layouts, and let the exact engines treat them as hints, never answers.
export function prepare(input) {
  if (!input || typeof input !== "object") return { error: "A entrada precisa ser um objeto JSON." };
  if (!Array.isArray(input.rooms)) return { error: "rooms precisa ser uma lista." };
  const rooms = input.rooms.map(room => room && ({
    ...room,
    minSide: room.minSide ?? input.minSide,
    void: Boolean(room.void),
    exterior: room.exterior ?? !(room.void || room.corridor),
    facades: room.facades ?? [],
  }));
  const error = validate(rooms);
  if (error) return { error };
  const warm = {};
  if (input.warm && typeof input.warm === "object" && !Array.isArray(input.warm)) {
    for (const objective of OBJECTIVES) {
      const boxes = usableWarm(input.warm[objective.id], rooms);
      if (boxes) warm[objective.id] = boxes;
    }
  }
  // "loose-rect" was folded into "loose"; keep old envelopes working.
  const engine = engines[input.engine] ? input.engine : input.engine === "loose-rect" ? "loose" : "cp-sat";
  return { rooms, engine, warm };
}

// Validate first, then run the chosen engine asynchronously in browser and CLI.
export async function solve(input) {
  const { rooms, engine, warm, error } = prepare(input);
  if (error) return { ok: false, error };
  return { ok: true, engine, ...(await generateOptions({ rooms, engine, warm })) };
}
