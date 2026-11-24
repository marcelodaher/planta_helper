import { cells, validateLoose, sharedWall, bounds, contactGraph, MAX_ASPECT, MIN_DOOR } from "./layout.mjs";

const MAX_CANDIDATES = 12; // distinct contact graphs kept per objective

// Target area per room, in cells.
function targetMap(rooms, objective) {
  return new Map(rooms.map(room => [room.name, cells(objective === "max" || (objective === "corridor" && !room.corridor)
    ? room.maxArea
    : room.minArea)]));
}

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

// Walk orderings, first-room shapes and scales, keeping the cheapest valid plant
// per contact graph and stopping at a time budget. The ranked list is the pool of
// alternatives; the first entry is the plant the loose engine returns.
export function collectLoose(rooms, objective, budget = 300) {
  const targets = targetMap(rooms, objective);
  const scales = objective === "max" ? [1.25, 1.12, 1, 0.9, 0.8] : [0.75, 0.8, 0.9, 1, 1.12];
  const deadline = Date.now() + budget;
  const best = new Map();
  let expired = false;
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
        const graph = contactGraph(layout);
        const cost = layoutCost(layout, rooms, objective) + (aspect(layout) > MAX_ASPECT ? 1e6 : 0);
        const known = best.get(graph);
        if (!known || cost < known.cost) best.set(graph, { layout, cost });
        if (best.size && Date.now() > deadline) {
          expired = true;
          break;
        }
      }
      if (expired) break;
    }
    if (expired || best.size >= MAX_CANDIDATES) break;
  }
  const ranked = [...best.values()].sort((a, b) => a.cost - b.cost).map(entry => entry.layout);
  const believable = ranked.filter(layout => aspect(layout) <= MAX_ASPECT);
  return believable.length ? believable : ranked.slice(0, 1);
}

// The walk's plant is the guaranteed answer inside the loose engine (generator.mjs);
// this module stays solver-free: pure JavaScript, no CP-SAT import.
