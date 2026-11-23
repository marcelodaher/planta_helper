export const GRID = 10; // Every dimension and position uses 10 cm cells.
export const MIN_DOOR = 10; // Two connected rooms need at least 1 m of shared wall.
export const MAX_ASPECT = 3; // A house longer than 3:1 is not a believable plan.

// Facades a room can open onto, in compass order with Portuguese labels.
export const FACADES = { north: "norte", east: "leste", south: "sul", west: "oeste" };

export const OBJECTIVES = [
  { id: "min_area", label: "Menor área", key: "min" },
  { id: "max_area", label: "Maior área", key: "max" },
  { id: "min_corridor", label: "Menor corredor", key: "corridor" },
];

export const cells = area => Math.round(area * GRID * GRID);
export const minSideCells = room => Math.ceil(room.minSide * GRID);

// Bounding box of a layout, in cells.
export function bounds(layout) {
  return layout.reduce((box, room) => ({
    minX: Math.min(box.minX, room.x),
    minY: Math.min(box.minY, room.y),
    maxX: Math.max(box.maxX, room.x + room.w),
    maxY: Math.max(box.maxY, room.y + room.h),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

// Length of the shared wall between two rooms, in cells.
export function sharedWall(a, b) {
  const vertical = (a.x + a.w === b.x || b.x + b.w === a.x) &&
    Math.max(a.y, b.y) < Math.min(a.y + a.h, b.y + b.h);
  if (vertical) return Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const horizontal = (a.y + a.h === b.y || b.y + b.h === a.y) &&
    Math.max(a.x, b.x) < Math.min(a.x + a.w, b.x + b.w);
  if (horizontal) return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  return 0;
}

// Canonical contact graph: one labelled edge per pair that shares a door-width wall.
// Translation, rotation and room resizing keep the signature; a new or missing
// contact produces a different plan topology.
export function contactGraph(layout) {
  return layout
    .flatMap((a, i) => layout.slice(i + 1)
      .filter(b => sharedWall(a, b) >= MIN_DOOR)
      .map(b => [a.room, b.room].sort().join("|")))
    .sort()
    .join(";");
}

// True when another room fully covers this edge of the room.
function edgeCovered(room, side, others) {
  const vertical = side === "left" || side === "right";
  const start = vertical ? room.y : room.x;
  const end = vertical ? room.y + room.h : room.x + room.w;
  const intervals = [];
  for (const other of others) {
    if (other === room) continue;
    let touches = false;
    let from = 0;
    let to = 0;
    if (side === "left") {
      touches = other.x + other.w === room.x;
      from = Math.max(room.y, other.y);
      to = Math.min(room.y + room.h, other.y + other.h);
    } else if (side === "right") {
      touches = other.x === room.x + room.w;
      from = Math.max(room.y, other.y);
      to = Math.min(room.y + room.h, other.y + other.h);
    } else if (side === "bottom") {
      touches = other.y + other.h === room.y;
      from = Math.max(room.x, other.x);
      to = Math.min(room.x + room.w, other.x + other.w);
    } else {
      touches = other.y === room.y + room.h;
      from = Math.max(room.x, other.x);
      to = Math.min(room.x + room.w, other.x + other.w);
    }
    if (touches && to > from) intervals.push([from, to]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let cursor = start;
  for (const [from, to] of intervals) {
    if (from > cursor) return false;
    cursor = Math.max(cursor, to);
    if (cursor >= end) return true;
  }
  return cursor >= end;
}

// True when any part of the room's edge is exposed to the outside.
// Voids (open areas) never count as solid, so rooms touching them are exterior.
export function touchesExterior(room, others) {
  const solid = others.filter(other => !other.void);
  return ["left", "right", "bottom", "top"].some(side => !edgeCovered(room, side, solid));
}

// Room sizes, overlaps, connections and exterior contact. Return "" or the first problem.
function checkRooms(layout, rooms) {
  if (!Array.isArray(layout) || layout.length !== rooms.length) return "A planta precisa de um retângulo por cômodo.";
  if (new Set(layout.map(room => room.room)).size !== layout.length) return "A planta repete cômodos.";
  const byName = new Map(rooms.map(room => [room.name, room]));
  for (const placed of layout) {
    const room = byName.get(placed.room);
    if (!room) return `Cômodo desconhecido: ${placed.room}.`;
    if (![placed.x, placed.y, placed.w, placed.h].every(Number.isInteger)) return `Coordenadas inválidas em ${placed.room}.`;
    if (placed.w < minSideCells(room) || placed.h < minSideCells(room)) return `${placed.room} é estreito demais.`;
    const area = placed.w * placed.h;
    if (area < cells(room.minArea) || area > cells(room.maxArea)) return `Área de ${placed.room} fora do intervalo.`;
  }
  for (let i = 0; i < layout.length; i++) {
    for (let j = i + 1; j < layout.length; j++) {
      const a = layout[i], b = layout[j];
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) return `${a.room} e ${b.room} se sobrepõem.`;
    }
  }
  const placed = new Map(layout.map(room => [room.room, { ...room, void: Boolean(byName.get(room.room)?.void) }]));
  const merged = [...placed.values()];
  const box = bounds(layout);
  // North is the lowest y, south the highest; west the lowest x, east the highest.
  const onEdge = (room, facade) =>
    (facade === "north" && room.y === box.minY) ||
    (facade === "south" && room.y + room.h === box.maxY) ||
    (facade === "west" && room.x === box.minX) ||
    (facade === "east" && room.x + room.w === box.maxX);
  for (const room of rooms) {
    if (room.exterior && !touchesExterior(placed.get(room.name), merged)) return `${room.name} não toca o perímetro externo.`;
    for (const facade of room.facades ?? []) {
      if (!onEdge(placed.get(room.name), facade)) return `${room.name} não tem abertura para ${FACADES[facade]}.`;
    }
    for (const peer of room.links) {
      if (room.name > peer) continue;
      if (sharedWall(placed.get(room.name), placed.get(peer)) < MIN_DOOR) return `${room.name} e ${peer} não têm parede suficiente.`;
    }
  }
  return "";
}

// Tight layout: rooms must tile a single rectangle without gaps.
export function validateLayout(layout, rooms) {
  const error = checkRooms(layout, rooms);
  if (error) return error;
  const box = bounds(layout);
  const roomArea = layout.reduce((sum, room) => sum + room.w * room.h, 0);
  if (roomArea !== (box.maxX - box.minX) * (box.maxY - box.minY)) return "A planta tem lacunas.";
  return "";
}

// Loose layout: any connected rectilinear footprint without holes.
export function validateLoose(layout, rooms) {
  const error = checkRooms(layout, rooms);
  if (error) return error;
  const reached = new Set([layout[0].room]);
  const queue = [layout[0]];
  while (queue.length) {
    const room = queue.shift();
    for (const other of layout) {
      if (!reached.has(other.room) && sharedWall(room, other) > 0) {
        reached.add(other.room);
        queue.push(other);
      }
    }
  }
  if (reached.size !== layout.length) return "A planta tem cômodos separados.";
  if (hasHole(layout)) return "A planta tem um vão fechado.";
  return "";
}

// True when the bounding box contains an empty region not reachable from its border.
function hasHole(layout) {
  const box = bounds(layout);
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  if (width * height > 250000) return false;
  const grid = new Uint8Array(width * height);
  for (const room of layout) {
    for (let y = room.y - box.minY; y < room.y - box.minY + room.h; y++) {
      for (let x = room.x - box.minX; x < room.x - box.minX + room.w; x++) grid[y * width + x] = 1;
    }
  }
  const stack = [];
  const visit = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    if (grid[y * width + x] !== 0) return;
    grid[y * width + x] = 2;
    stack.push([x, y]);
  };
  for (let x = 0; x < width; x++) {
    visit(x, 0);
    visit(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    visit(0, y);
    visit(width - 1, y);
  }
  while (stack.length) {
    const [x, y] = stack.pop();
    visit(x + 1, y);
    visit(x - 1, y);
    visit(x, y + 1);
    visit(x, y - 1);
  }
  return grid.some(cell => cell === 0);
}
