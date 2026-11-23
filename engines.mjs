import { cells, validateLayout, validateLoose, sharedWall, bounds, MAX_ASPECT, MIN_DOOR } from "./layout.mjs";

// Outer rectangles are tried in objective order; the first valid tiling wins.
const ASPECTS = [1, 1.2, 0.8, 1.45, 0.65, 1.8, 0.55, 2.4, 0.4];
const SCALES = {
  min: [1, 1.05, 1.12, 1.2, 1.3, 1.45],
  max: [1, 0.97, 0.93, 0.88, 0.82, 0.76],
  corridor: [1, 0.97, 0.93, 0.88, 0.82, 0.76, 1.05, 1.12],
};
const BRANCH_BUDGET = 4000;
const MAX_BRANCH = 6;

// Target area per room, in cells.
function targetMap(rooms, objective) {
  return new Map(rooms.map(room => [room.name, cells(objective === "max" || (objective === "corridor" && !room.corridor)
    ? room.maxArea
    : room.minArea)]));
}

const leaf = (room, target) => ({ kind: "leaf", room, target });

// Greedy bottom-up: merge the blocks with the most connections first.
function buildGreedyTree(rooms, targets) {
  const adjacency = new Map(rooms.map(room => [room.name, new Set(room.links)]));
  let blocks = rooms.map(room => ({ names: new Set([room.name]), node: leaf(room, targets.get(room.name)) }));
  while (blocks.length > 1) {
    let best = null;
    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        let weight = 0;
        for (const name of blocks[i].names) for (const peer of adjacency.get(name)) if (blocks[j].names.has(peer)) weight++;
        const score = weight * 1e6 + Math.max(blocks[i].node.target, blocks[j].node.target);
        if (!best || score > best.score) best = { i, j, score };
      }
    }
    const { i, j } = best;
    const node = { kind: "split", left: blocks[i].node, right: blocks[j].node, target: blocks[i].node.target + blocks[j].node.target };
    const names = new Set([...blocks[i].names, ...blocks[j].names]);
    blocks = blocks.filter((_, index) => index !== i && index !== j);
    blocks.push({ names, node });
  }
  return blocks[0].node;
}

// Top-down: split the graph into two groups with as few crossing connections as possible.
function buildCutTree(rooms, targets) {
  const adjacency = new Map(rooms.map(room => [room.name, new Set(room.links)]));
  const byName = new Map(rooms.map(room => [room.name, room]));
  function split(names) {
    if (names.length === 1) return leaf(byName.get(names[0]), targets.get(names[0]));
    const order = bfsOrder(names, adjacency);
    let best = null;
    for (let cut = 1; cut < order.length; cut++) {
      const left = new Set(order.slice(0, cut));
      let crossing = 0;
      for (const name of left) for (const peer of adjacency.get(name)) if (!left.has(peer)) crossing++;
      const leftTarget = order.slice(0, cut).reduce((sum, name) => sum + targets.get(name), 0);
      const rightTarget = order.slice(cut).reduce((sum, name) => sum + targets.get(name), 0);
      const score = crossing * 1e6 + Math.abs(leftTarget - rightTarget);
      if (!best || score < best.score) best = { cut, score };
    }
    const left = split(order.slice(0, best.cut));
    const right = split(order.slice(best.cut));
    return { kind: "split", left, right, target: left.target + right.target };
  }
  return split(rooms.map(room => room.name));
}

// Visit rooms in connection order, starting from the most connected one.
function bfsOrder(names, adjacency) {
  const set = new Set(names);
  const degree = name => [...adjacency.get(name)].filter(peer => set.has(peer)).length;
  const start = [...names].sort((a, b) => degree(b) - degree(a))[0];
  const seen = new Set([start]);
  const queue = [start];
  const order = [];
  while (queue.length) {
    const name = queue.shift();
    order.push(name);
    for (const peer of adjacency.get(name)) {
      if (set.has(peer) && !seen.has(peer)) {
        seen.add(peer);
        queue.push(peer);
      }
    }
  }
  for (const name of names) if (!seen.has(name)) order.push(name);
  return order;
}

// Return a few complete tilings for a subtree; both split directions are tried.
function candidates(node, rect, budget) {
  if (budget.left-- <= 0) return [];
  if (node.kind === "leaf") {
    const area = rect.w * rect.h;
    if (area < cells(node.room.minArea) || area > cells(node.room.maxArea)) return [];
    if (rect.w < Math.ceil(node.room.minSide * 10) || rect.h < Math.ceil(node.room.minSide * 10)) return [];
    return [[{ room: node.room.name, color: node.room.color, x: rect.x, y: rect.y, w: rect.w, h: rect.h }]];
  }
  const results = [];
  for (const direction of rect.w >= rect.h ? ["v", "h"] : ["h", "v"]) {
    const extent = direction === "v" ? rect.w : rect.h;
    const ideal = Math.round((node.left.target / node.target) * extent);
    const span = Math.max(1, Math.round(extent * 0.2));
    const branch = [];
    for (let offset = 0; offset <= span; offset++) {
      for (const size of offset ? [ideal - offset, ideal + offset] : [ideal]) {
        if (size < 1 || size >= extent) continue;
        const leftRect = direction === "v" ? { ...rect, w: size } : { ...rect, h: size };
        const rightRect = direction === "v"
          ? { ...rect, x: rect.x + size, w: rect.w - size }
          : { ...rect, y: rect.y + size, h: rect.h - size };
        const lefts = candidates(node.left, leftRect, budget);
        if (!lefts.length) continue;
        const rights = candidates(node.right, rightRect, budget);
        if (!rights.length) continue;
        for (const left of lefts) for (const right of rights) {
          branch.push([...left, ...right]);
          if (branch.length >= MAX_BRANCH) break;
        }
        if (branch.length >= MAX_BRANCH) break;
      }
      if (branch.length >= MAX_BRANCH) break;
    }
    results.push(...branch);
  }
  return results;
}

// Try outer rectangles in objective order and return the first valid tiling.
function solveWithTree(tree, rooms, objective) {
  for (const scale of SCALES[objective]) {
    for (const aspect of ASPECTS) {
      const area = Math.max(1, Math.round(tree.target * scale));
      const w = Math.max(1, Math.round(Math.sqrt(area * aspect)));
      const h = Math.max(1, Math.round(area / w));
      for (const layout of candidates(tree, { x: 0, y: 0, w, h }, { left: BRANCH_BUDGET })) {
        if (validateLayout(layout, rooms) === "") return layout;
      }
    }
  }
  return null;
}

// Guillotine engines are fast but cannot express a corridor with many doors;
// when the tree finds no tiling they fall back to the placement heuristic.
function engine(id, label, description, build) {
  return {
    id,
    label,
    description,
    validate: validateLoose,
    solve(rooms, objective) {
      const targets = targetMap(rooms, objective);
      const layout = solveWithTree(build(rooms, targets), rooms, objective);
      if (layout) return { status: "heuristic", layout };
      return looseSolve(rooms, objective);
    },
  };
}

export const greedyEngine = engine(
  "greedy",
  "Guloso",
  "Agrupa cômodos pela conexão e fatia a planta; se o encaixe falhar, usa a busca por posicionamento.",
  buildGreedyTree,
);

export const cutEngine = engine(
  "cut",
  "Cortes no grafo",
  "Divide o grafo em grupos com poucas conexões e fatia a planta; se o encaixe falhar, usa a busca por posicionamento.",
  buildCutTree,
);

// Candidate room shapes within its limits, near a goal area.
function shapesFor(room, goal) {
  const min = Math.ceil(room.minSide * 10);
  const low = cells(room.minArea);
  const high = cells(room.maxArea);
  const target = Math.max(low, Math.min(high, goal));
  const found = [];
  for (let w = min; w * min <= high; w++) {
    const h = Math.max(min, Math.round(target / w));
    const area = w * h;
    if (area >= low && area <= high) found.push({ w, h });
  }
  return found
    .sort((a, b) => Math.abs(a.w * a.h - target) - Math.abs(b.w * b.h - target) || Math.abs(a.w - a.h) - Math.abs(b.w - b.h))
    .slice(0, 12);
}

// Candidate positions touching an already placed room on each side.
function positionsAround(anchor, shape) {
  const ys = [anchor.y, anchor.y + anchor.h - shape.h, anchor.y + Math.floor((anchor.h - shape.h) / 2)];
  const xs = [anchor.x, anchor.x + anchor.w - shape.w, anchor.x + Math.floor((anchor.w - shape.w) / 2)];
  return [
    ...ys.map(y => ({ x: anchor.x + anchor.w, y, ...shape })),
    ...ys.map(y => ({ x: anchor.x - shape.w, y, ...shape })),
    ...xs.map(x => ({ x, y: anchor.y + anchor.h, ...shape })),
    ...xs.map(x => ({ x, y: anchor.y - shape.h, ...shape })),
  ];
}

const overlaps = (candidate, placed) => placed.some(other =>
  candidate.x < other.x + other.w && candidate.x + candidate.w > other.x &&
  candidate.y < other.y + other.h && candidate.y + candidate.h > other.y);

// Candidate shapes for the first room: near its target, its largest and its smallest.
function firstShapes(room, goal) {
  const seen = new Set();
  return [goal, cells(room.maxArea), cells(room.minArea)]
    .flatMap(value => shapesFor(room, value))
    .filter(shape => {
      const key = `${shape.w}x${shape.h}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// Visit rooms in connection order, starting from the most connected rooms.
function looseOrderings(rooms) {
  const adjacency = new Map(rooms.map(room => [room.name, new Set(room.links)]));
  const byName = new Map(rooms.map(room => [room.name, room]));
  const seenOrders = new Set();
  return [...rooms]
    .sort((a, b) => b.links.length - a.links.length)
    .slice(0, 5)
    .map(start => {
      const seen = new Set([start.name]);
      const order = [start];
      const queue = [start.name];
      while (queue.length) {
        const name = queue.shift();
        for (const peer of adjacency.get(name)) {
          if (seen.has(peer)) continue;
          seen.add(peer);
          order.push(byName.get(peer));
          queue.push(peer);
        }
      }
      // Rooms without connections still need a place in the order.
      for (const room of rooms) if (!seen.has(room.name)) order.push(room);
      return order;
    })
    .filter(order => {
      const key = order.map(room => room.name).join(",");
      if (seenOrders.has(key)) return false;
      seenOrders.add(key);
      return true;
    });
}

// Place rooms one at a time next to a connected neighbour; the footprint may be L-shaped.
function placeLoose(order, targets, firstShape) {
  const placed = [];
  for (const room of order) {
    const shapes = shapesFor(room, targets.get(room.name));
    if (!shapes.length) return null;
    if (!placed.length) {
      placed.push({ ...(firstShape ?? shapes[0]), x: 0, y: 0, room: room.name, color: room.color });
      continue;
    }
    const links = new Set(room.links);
    const box = bounds(placed);
    const current = (box.maxX - box.minX) * (box.maxY - box.minY);
    let best = null;
    for (const shape of shapes) {
      for (const anchor of placed) {
        for (const candidate of positionsAround(anchor, shape)) {
          if (overlaps(candidate, placed)) continue;
          const count = placed.filter(other => links.has(other.room) && sharedWall(candidate, other) >= MIN_DOOR).length;
          // A room without connections may sit next to any placed room.
          if (links.size && !count) continue;
          const grown = bounds([...placed, candidate]);
          const width = grown.maxX - grown.minX;
          const height = grown.maxY - grown.minY;
          const growth = width * height - current;
          const score = count * 100000 - growth;
          if (!best || score > best.score) best = { ...candidate, room: room.name, color: room.color, score };
        }
      }
    }
    if (!best) return null;
    delete best.score;
    placed.push(best);
  }
  return placed;
}

// Cost of a layout for one objective; lower is better and slivers are penalized.
function layoutCost(layout, rooms, objective) {
  const box = bounds(layout);
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  const boxArea = width * height;
  const used = layout.reduce((sum, room) => sum + room.w * room.h, 0);
  const corridors = new Set(rooms.filter(room => room.corridor).map(room => room.name));
  const corridor = layout.reduce((sum, room) => sum + (corridors.has(room.room) ? room.w * room.h : 0), 0);
  const skew = Math.abs(width - height) / Math.max(width, height);
  if (objective === "max") return -used + skew * 20000;
  if (objective === "corridor") return corridor * 1000 + boxArea + skew * 20000;
  return boxArea + corridor + skew * 2000;
}

// Bounding-box aspect ratio; long slivers are not believable houses.
function aspect(layout) {
  const box = bounds(layout);
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  return Math.max(width, height) / Math.max(1, Math.min(width, height));
}

// Try to land every room with named facades on the matching edge of the house.
// Moves are best-effort; the shared validator rejects the candidates that fail.
function fitFacades(layout, rooms) {
  const info = new Map(rooms.map(room => [room.name, room]));
  if (!rooms.some(room => room.facades?.length)) return layout;
  const work = layout.map(room => ({ ...room }));
  const linksBreak = room => (info.get(room.room)?.links ?? []).some(peer => {
    const other = work.find(candidate => candidate.room === peer);
    return !other || sharedWall(room, other) < MIN_DOOR;
  });
  for (const room of work) {
    for (const facade of info.get(room.room)?.facades ?? []) {
      const box = bounds(work);
      const x = facade === "west" ? box.minX : facade === "east" ? box.maxX - room.w : room.x;
      const y = facade === "north" ? box.minY : facade === "south" ? box.maxY - room.h : room.y;
      if (x === room.x && y === room.y) continue;
      const moved = { ...room, x, y };
      if (overlaps(moved, work.filter(other => other !== room))) continue;
      if (linksBreak(moved)) continue;
      room.x = x;
      room.y = y;
    }
  }
  return work;
}

// Loose engine: accepts L-shaped or irregular footprints, not only a tight rectangle.
// It iterates over orderings, first-room shapes and scales, returning the first believable layout.
function looseSolve(rooms, objective) {
  const targets = targetMap(rooms, objective);
  const scales = objective === "max" ? [1.25, 1.12, 1, 0.9, 0.8] : [0.75, 0.8, 0.9, 1, 1.12];
  let fallback = null;
  for (const order of looseOrderings(rooms)) {
    const first = order[0];
    const shapes = firstShapes(first, targets.get(first.name))
      .sort((a, b) => objective === "max" ? b.w * b.h - a.w * a.h : a.w * a.h - b.w * b.h);
    for (const scale of scales) {
      const scaled = new Map([...targets].map(([name, goal]) => [name, Math.round(goal * scale)]));
      for (const shape of shapes) {
        const placed = placeLoose(order, scaled, shape);
        if (!placed) continue;
        const layout = fitFacades(placed, rooms);
        if (validateLoose(layout, rooms) !== "") continue;
        if (aspect(layout) <= MAX_ASPECT) return { status: "loose", layout };
        fallback ??= layout;
      }
    }
  }
  return fallback ? { status: "loose", layout: fallback } : { status: "failed", layout: null };
}

export const looseEngine = {
  id: "loose",
  label: "Livre",
  description: "Permite planta em L ou outro formato; não exige retângulo externo.",
  validate: validateLoose,
  solve: looseSolve,
};
