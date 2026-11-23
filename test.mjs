import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { solve, engineList } from "./generator.mjs";
import { validateLayout, validateLoose, contactGraph } from "./layout.mjs";
import { samples } from "./samples.mjs";

// Keep the suite fast; quality measurements live in `npm run bench`.
process.env.PLANTA_SOLVE_SECONDS ??= "3";

const area = layout => layout.reduce((sum, room) => sum + room.w * room.h, 0);

// The contact graph keeps topology and ignores where the rooms sit or how big they are.
const graphOne = [
  { room: "a", x: 0, y: 0, w: 10, h: 10 },
  { room: "b", x: 10, y: 0, w: 10, h: 10 },
];
assert.equal(contactGraph(graphOne), "a|b");
assert.equal(contactGraph(graphOne.map(room => ({ ...room, x: room.x + 50, y: room.y + 30 }))), "a|b");
assert.equal(contactGraph([...graphOne, { room: "c", x: 0, y: 10, w: 10, h: 10 }]), "a|b;a|c");

// Every engine must return complete, valid tilings on every sample.
for (const engine of engineList) {
  for (const sample of samples) {
    const result = await solve({ ...sample.input, engine: engine.id });
    assert.equal(result.ok, true, `${engine.id}/${sample.id} should be valid`);
    assert.deepEqual(result.options.map(option => option.id), ["min_area", "max_area", "min_corridor"]);
    assert(result.options.some(option => option.layout), `${engine.id}/${sample.id} should produce a tiling`);
    for (const option of result.options) {
      if (!option.layout) continue;
      assert.equal(engine.validate(option.layout, sample.input.rooms), "", `${engine.id}/${sample.id}/${option.id}`);
      assert(option.layout.every(room => room.touchesExterior !== undefined), "rooms should carry the exterior flag");
    }
  }
}

// The exact engine should prove the extremes on the suite sample.
const suite = samples.find(sample => sample.id === "suite").input;
const result = await solve({ ...suite, engine: "cp-sat" });
assert.equal(result.ok, true);
assert.deepEqual(result.options.map(option => option.id), ["min_area", "max_area", "min_corridor"]);
assert(result.options.every(option => option.status === "optimal" && option.layout));
assert(area(result.options[0].layout) <= area(result.options[1].layout));

// A corridor stays small even when the house grows.
const corridor = await solve({
  rooms: [
    { name: "sala", minArea: 4, maxArea: 9, minSide: 2, links: ["corredor"] },
    { name: "corredor", corridor: true, minArea: 2, maxArea: 4, minSide: 1, links: ["sala"] },
  ],
  engine: "cp-sat",
});
assert.equal(corridor.ok, true);
assert(area(corridor.options[0].layout) <= area(corridor.options[1].layout));
assert.equal(area(corridor.options[1].layout), 1300);
const hall = corridor.options[2].layout.find(room => room.room === "corredor");
assert.equal(hall.w * hall.h, 200);

// Validation still rejects bad input.
assert.deepEqual(await solve({ ...suite, rooms: [] }), { ok: false, error: "Informe o nome de todos os cômodos." });
assert.equal((await solve({ ...suite, rooms: [{ ...suite.rooms[0], links: [] }, ...suite.rooms.slice(1)] })).ok, false);

// A void is an open area: rooms touching it count as having external contact.
const voidRooms = [
  { name: "sala", minArea: 4, maxArea: 4, minSide: 1, exterior: true, links: ["quarto"] },
  { name: "quarto", minArea: 3, maxArea: 3, minSide: 1, exterior: true, links: ["sala", "banho"] },
  { name: "banho", minArea: 2, maxArea: 2, minSide: 1, exterior: true, links: ["quarto", "cozinha"] },
  { name: "cozinha", minArea: 3, maxArea: 3, minSide: 1, exterior: true, links: ["banho"] },
  { name: "vazio", minArea: 4, maxArea: 4, minSide: 1, void: true, links: [] },
];
const voidLayout = [
  { room: "sala", color: "green", x: 0, y: 0, w: 40, h: 10 },
  { room: "quarto", color: "green", x: 0, y: 10, w: 10, h: 30 },
  { room: "cozinha", color: "green", x: 30, y: 10, w: 10, h: 30 },
  { room: "banho", color: "green", x: 10, y: 10, w: 20, h: 10 },
  { room: "vazio", color: "gray", x: 10, y: 20, w: 20, h: 20 },
];
assert.equal(validateLayout(voidLayout, voidRooms), "");
assert.equal(
  validateLayout(voidLayout, voidRooms.map(room => room.name === "vazio" ? { ...room, void: false } : room)),
  "banho não toca o perímetro externo.",
);
const voidSolve = await solve({ rooms: voidRooms });
assert.equal(voidSolve.ok, true);
const voidOption = voidSolve.options.find(option => option.layout);
assert(voidOption, "cp-sat should tile a plan with a void");
assert.equal(validateLayout(voidOption.layout, voidRooms), "");

// Connections are optional: rooms without links may touch each other.
const unlinkedRooms = [
  { name: "a", minArea: 4, maxArea: 6, minSide: 1.5, exterior: true, links: [] },
  { name: "b", minArea: 4, maxArea: 6, minSide: 1.5, exterior: true, links: [] },
];
for (const engine of engineList) {
  const unlinked = await solve({ rooms: unlinkedRooms, engine: engine.id });
  assert.equal(unlinked.ok, true, `${engine.id} should accept rooms without connections`);
  assert(unlinked.options.some(option => option.layout), `${engine.id} should tile rooms without connections`);
}

// The loose validator accepts a rectangle with open space inside; the tight one does not.
const gapRooms = [
  { name: "sala", minArea: 4, maxArea: 8, minSide: 1, exterior: true, links: ["quarto"] },
  { name: "quarto", minArea: 4, maxArea: 4, minSide: 1, exterior: true, links: ["sala"] },
];
const gapLayout = [
  { room: "sala", color: "green", x: 0, y: 0, w: 40, h: 20 },
  { room: "quarto", color: "green", x: 0, y: 20, w: 20, h: 20 },
];
assert.equal(validateLoose(gapLayout, gapRooms), "");
assert.notEqual(validateLayout(gapLayout, gapRooms), "");
const looseSolve = await solve({ rooms: gapRooms, engine: "loose-rect" });
assert.equal(looseSolve.ok, true);
assert(looseSolve.options.some(option => option.layout), "loose-rect should produce a layout");

// Named facades pin the room's side to the matching wall of the house.
const facadeRooms = [
  { name: "sala", minArea: 8, maxArea: 24, minSide: 3, links: ["quarto"], facades: ["north", "west"] },
  { name: "quarto", minArea: 8, maxArea: 24, minSide: 3, links: ["sala"], facades: ["south"] },
];
const facing = [
  { room: "sala", color: "gray", x: 0, y: 0, w: 40, h: 30 },
  { room: "quarto", color: "gray", x: 40, y: 0, w: 30, h: 40 },
];
assert.equal(validateLoose(facing, facadeRooms), "");
assert.equal(
  validateLoose(facing.map(room => room.room === "sala" ? { ...room, y: 10 } : room), facadeRooms),
  "sala não tem abertura para norte.",
);
assert.equal(
  validateLoose([
    { room: "sala", color: "gray", x: 30, y: 0, w: 40, h: 30 },
    { room: "quarto", color: "gray", x: 0, y: 0, w: 30, h: 40 },
  ], facadeRooms),
  "sala não tem abertura para oeste.",
);
for (const engine of engineList) {
  const faced = await solve({ rooms: facadeRooms, engine: engine.id });
  assert.equal(faced.ok, true, `${engine.id} should accept facades`);
  const solved = faced.options.filter(option => option.layout);
  assert(solved.length >= 1, `${engine.id} should place rooms with facades`);
  for (const option of solved) {
    assert.equal(engine.validate(option.layout, facadeRooms), "", `${engine.id}/${option.id} should honour facades`);
  }
}

// Complex regression case: casa_prado.json (corridor hub, garden void, 12 rooms).
// The exact engines are best-effort inside the test budget, so only the engines with a
// guaranteed fallback must always answer; anything they return must validate.
const prado = JSON.parse(readFileSync(new URL("./casa_prado.json", import.meta.url), "utf8"));
const boxArea = option => (option.bounds.maxX - option.bounds.minX) * (option.bounds.maxY - option.bounds.minY);
for (const engine of engineList) {
  const result = await solve({ ...prado.input, engine: engine.id });
  assert.equal(result.ok, true, `casa_prado/${engine.id} should be valid input`);
  for (const option of result.options) {
    if (!option.layout) continue;
    assert.equal(engine.validate(option.layout, prado.input.rooms), "", `casa_prado/${engine.id}/${option.id}`);
    assert(option.bounds, `casa_prado/${engine.id}/${option.id} should report bounds`);
  }
  if (engine.id !== "cp-sat") {
    assert.deepEqual(
      result.options.filter(option => option.layout && engine.validate(option.layout, prado.input.rooms) === "").length,
      3,
      `casa_prado/${engine.id} should answer every objective`,
    );
  }
  // Every alternative is a valid plant with a topology not already on screen.
  const shownGraphs = new Set(result.options.filter(option => option.layout).map(option => contactGraph(option.layout)));
  const alternativeGraphs = new Set();
  for (const alternative of result.alternatives) {
    assert.equal(validateLoose(alternative.layout, prado.input.rooms), "", `casa_prado/${engine.id}/${alternative.id}`);
    assert(alternative.bounds, `casa_prado/${engine.id}/${alternative.id} should report bounds`);
    const graph = contactGraph(alternative.layout);
    assert(!shownGraphs.has(graph), `casa_prado/${engine.id}/${alternative.id} repeats an option`);
    assert(!alternativeGraphs.has(graph), `casa_prado/${engine.id}/${alternative.id} repeats a topology`);
    alternativeGraphs.add(graph);
  }
  if (engine.id === "loose") assert(result.alternatives.length > 0, "casa_prado/loose should offer alternatives");
  const [smallest, largest] = result.options;
  if (smallest.layout && largest.layout) {
    assert(boxArea(smallest) <= boxArea(largest), `casa_prado/${engine.id} should keep min <= max`);
  }
}
console.log("Engine checks passed.");
