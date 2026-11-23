import { CpModel, CpSat, LinearExpr } from "cp-sat-wasm";
import { FACADES, GRID, MAX_ASPECT, MIN_DOOR, OBJECTIVES, cells, touchesExterior, validateLayout, validateLoose } from "./layout.mjs";
import { greedyEngine, cutEngine, looseEngine } from "./engines.mjs";

// Time limit per objective: bigger houses need more search; tests shorten it.
const SOLVE_MAX_SECONDS = 30;
const SOLVE_MIN_SECONDS = 5;
function solveSeconds(rooms) {
  const override = Number(globalThis.process?.env?.PLANTA_SOLVE_SECONDS);
  return override || Math.min(SOLVE_MAX_SECONDS, Math.max(SOLVE_MIN_SECONDS, rooms.length * 1.5));
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

// Build an exact grid model: rooms fit one exterior rectangle without overlap.
// A tight model tiles the rectangle; a loose model leaves open space inside it.
function buildModel(rooms, objective, loose = false) {
  const model = new CpModel();
  const maximumArea = rooms.reduce((sum, room) => sum + cells(room.maxArea), 0);
  const maximumSide = Math.max(1, maximumArea);
  const exteriorWidth = model.newIntVar(1, maximumSide, "exterior_width");
  const exteriorHeight = model.newIntVar(1, maximumSide, "exterior_height");
  const footprint = model.newIntVar(1, maximumArea, "footprint");
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
    const width = model.newIntVar(min, maximumSide, `${room.name}_width`);
    const height = model.newIntVar(min, maximumSide, `${room.name}_height`);
    const area = model.newIntVar(cells(room.minArea), cells(room.maxArea), `${room.name}_area`);
    const x = model.newIntVar(0, maximumSide, `${room.name}_x`);
    const y = model.newIntVar(0, maximumSide, `${room.name}_y`);
    const endX = model.newIntVar(0, maximumSide, `${room.name}_end_x`);
    const endY = model.newIntVar(0, maximumSide, `${room.name}_end_y`);
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
  if (objective === "corridor") model.minimize(corridorArea.times(maximumArea + 1).minus(area).plus(loose ? footprint : 0));
  return { model, variables, exteriorWidth, exteriorHeight, limit: maximumSide };
}

// Exact engine: CP-SAT proves the best layout or reports the best one found.
async function cpSatSolve(rooms, objective, { loose = false, hint = null, seconds = solveSeconds(rooms) } = {}) {
  const { model, variables, exteriorWidth, exteriorHeight, limit } = buildModel(rooms, objective, loose);
  applyHint(model, variables, exteriorWidth, exteriorHeight, limit, hint, rooms.some(room => room.facades?.length));
  const result = await CpSat.solve(model, { executor: "worker", maxTimeInSeconds: seconds });
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

const cpSatEngine = {
  id: "cp-sat",
  label: "CP-SAT",
  description: "Busca exata; pode comprovar o ótimo, mas demora mais.",
  exact: true,
  validate: validateLayout,
  solve: (rooms, objective, hint) => cpSatSolve(rooms, objective, { hint }),
};

// Exact loose engine: the tight model first (a tight layout is also a valid loose one),
// then the rectangular model with open space, then the loose heuristic.
const looseRectEngine = {
  id: "loose-rect",
  label: "Livre retangular",
  description: "Retângulo externo com espaços livres; usa CP-SAT e recorre ao heurístico livre se necessário.",
  exact: true,
  validate: validateLoose,
  solve: async (rooms, objective, hint) => {
    const budget = solveSeconds(rooms);
    const tight = await cpSatSolve(rooms, objective, { hint, seconds: budget });
    if (tight.layout && validateLayout(tight.layout, rooms) === "") return tight;
    const exact = await cpSatSolve(rooms, objective, { loose: true, hint, seconds: budget });
    if (exact.layout && validateLoose(exact.layout, rooms) === "") return exact;
    return looseEngine.solve(rooms, objective);
  },
};

export const engines = {
  "cp-sat": cpSatEngine,
  "loose-rect": looseRectEngine,
  greedy: greedyEngine,
  cut: cutEngine,
  loose: looseEngine,
};

export const engineList = Object.values(engines);

// Run one engine, then validate and annotate the layout.
// Seeds are tried in order until one engine run returns a layout.
async function finalize(engine, rooms, objective, seeds = []) {
  let result = await engine.solve(rooms, objective, seeds[0] ?? null);
  for (const seed of seeds.slice(1)) {
    if (result.layout) break;
    result = await engine.solve(rooms, objective, seed);
  }
  const { status, layout, bounds } = result;
  if (!layout) return { status, layout: null };
  const error = engine.validate(layout, rooms);
  if (error) return { status: "failed", layout: null, error };
  // Carry the void flag so touchesExterior can treat open areas as outside.
  const flags = new Map(rooms.map(room => [room.name, Boolean(room.void)]));
  const merged = layout.map(room => ({ ...room, void: flags.get(room.room) ?? false }));
  // Heuristic engines do not report an exterior rectangle; use the rooms' bounding box.
  const box = bounds ?? merged.reduce((box, room) => ({
    minX: Math.min(box.minX, room.x),
    minY: Math.min(box.minY, room.y),
    maxX: Math.max(box.maxX, room.x + room.w),
    maxY: Math.max(box.maxY, room.y + room.h),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  return {
    status,
    layout: merged.map(room => ({
      ...room,
      touchesExterior: touchesExterior(room, merged),
    })),
    bounds: box,
  };
}

// Whole-house area: the exterior rectangle when the engine reports one, else the rooms.
const optionArea = option => option.bounds
  ? (option.bounds.maxX - option.bounds.minX) * (option.bounds.maxY - option.bounds.minY)
  : option.layout.reduce((sum, room) => sum + room.w * room.h, 0);

// Cheap heuristic layout, used as the first hint for the exact engines.
function seedHint(rooms, objective) {
  const { layout } = looseEngine.solve(rooms, objective);
  return layout ? { layout } : null;
}

export async function generateOptions({ rooms, engine = "cp-sat" }) {
  const chosen = engines[engine] ?? cpSatEngine;
  const options = [];
  const carried = [];
  for (const objective of OBJECTIVES) {
    // Seed with the heuristic for this objective, then with the previous exact layout.
    const seeds = chosen.exact ? [seedHint(rooms, objective.key), ...carried].filter(Boolean) : [];
    const option = {
      id: objective.id,
      label: objective.label,
      engine: chosen.id,
      ...(await finalize(chosen, rooms, objective.key, seeds)),
    };
    options.push(option);
    if (option.layout) carried.unshift({ layout: option.layout, bounds: option.bounds });
  }
  // Keep "menor" no larger than "maior" even when a heuristic finds both.
  const [smallest, largest] = [options[0], options[1]];
  if (smallest.layout && largest.layout && optionArea(smallest) > optionArea(largest)) {
    options[0] = { ...smallest, layout: largest.layout, bounds: largest.bounds, status: largest.status };
    options[1] = { ...largest, layout: smallest.layout, bounds: smallest.bounds, status: smallest.status };
  }
  return options;
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

// Validate first, then run the chosen engine asynchronously in browser and CLI.
export async function solve(input) {
  if (!input || typeof input !== "object") return { ok: false, error: "A entrada precisa ser um objeto JSON." };
  if (!Array.isArray(input.rooms)) return { ok: false, error: "rooms precisa ser uma lista." };
  const rooms = input.rooms.map(room => room && ({
    ...room,
    minSide: room.minSide ?? input.minSide,
    void: Boolean(room.void),
    exterior: room.exterior ?? !(room.void || room.corridor),
    facades: room.facades ?? [],
  }));
  const error = validate(rooms);
  if (error) return { ok: false, error };
  const engine = engines[input.engine] ? input.engine : "cp-sat";
  return { ok: true, engine, options: await generateOptions({ rooms, engine }) };
}
