import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { solve, engineList, solveObjective, assemble, walkPreviews } from "./generator.mjs";
import { validateLayout, validateLoose, contactGraph, OBJECTIVES } from "./layout.mjs";
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

// A plant is validated by the engine that produced it: a time-limited exact run that found
// nothing falls back to the walk, and the option then carries the loose engine.
const validator = option => (engineList.find(engine => engine.id === option.engine) ?? engineList[0]).validate;

// Every engine must return complete, valid tilings on every sample.
for (const engine of engineList) {
  for (const sample of samples) {
    const result = await solve({ ...sample.input, engine: engine.id });
    assert.equal(result.ok, true, `${engine.id}/${sample.id} should be valid`);
    assert.deepEqual(result.options.map(option => option.id), ["min_area", "max_area", "min_corridor"]);
    assert(result.options.every(option => option.layout), `${engine.id}/${sample.id} should answer every objective`);
    for (const option of result.options) {
      assert.equal(validator(option)(option.layout, sample.input.rooms), "", `${engine.id}/${sample.id}/${option.id}`);
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

// The page runs the three objectives in separate workers: the per-objective entry points
// must merge into the same shape as the sequential solve.
const parallel = await Promise.all(OBJECTIVES.map(objective => solveObjective(suite.rooms, objective.id, "loose")));
const merged = assemble(parallel, suite.rooms);
assert.deepEqual(merged.options.map(option => option.id), ["min_area", "max_area", "min_corridor"]);
assert(merged.options.some(option => option.layout));
assert(merged.options.every(option => !option.layout || validateLoose(option.layout, suite.rooms) === ""));

// A warm start comes from localStorage and may describe rooms the user has since changed:
// it may only hint the solver, so the answer still has to validate against the current rooms.
const warmRooms = [
  { name: "sala", minArea: 9, maxArea: 16, minSide: 2, exterior: true, links: ["quarto"] },
  { name: "quarto", minArea: 6, maxArea: 12, minSide: 2, exterior: true, links: ["sala"] },
];
const staleWarm = [
  { room: "sala", x: -400, y: 30, w: 900, h: 1 },
  { room: "quarto", x: 9999, y: -7, w: 2.5, h: 2 },
  { room: "comodo_que_nao_existe", x: 0, y: 0, w: 10, h: 10 },
];
for (const engine of engineList) {
  const warmed = await solveObjective(warmRooms, "min_area", engine.id, staleWarm);
  assert(warmed.option.layout, `${engine.id} should answer despite a stale warm start`);
  assert.equal(validator(warmed.option)(warmed.option.layout, warmRooms), "", `${engine.id} should not echo the stale warm start`);
}

// The top-level API carries warm starts too: the CLI can replay what the page persists.
const replay = await solve({ rooms: warmRooms, engine: "cp-sat", warm: { min_area: staleWarm } });
assert.equal(replay.ok, true, "solve should accept a warm start");
assert(replay.options.every(option => option.layout && validator(option)(option.layout, warmRooms) === ""));

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
const looseSolve = await solve({ rooms: gapRooms, engine: "loose" });
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
    assert.equal(validator(option)(option.layout, facadeRooms), "", `${engine.id}/${option.id} should honour facades`);
  }
}

// Regression (fuzzed): on dense graphs the walk can miss a layout that exists; the loose
// engine must escalate to the exact loose model instead of handing back a blank card.
const walkMissedRooms = [
  { name: "r0", links: ["r1", "r2", "r4"], exterior: true, void: false, minSide: 1, minArea: 6, maxArea: 11 },
  { name: "r1", links: ["r0", "r3", "r5", "r6"], exterior: true, void: false, minSide: 2, minArea: 6, maxArea: 8 },
  { name: "r2", links: ["r0", "r5", "r7", "r3"], exterior: true, void: false, minSide: 3, minArea: 9, maxArea: 15 },
  { name: "r3", links: ["r1", "r2"], exterior: true, void: false, minSide: 3, minArea: 10, maxArea: 19 },
  { name: "r4", links: ["r0", "r6"], exterior: false, void: false, minSide: 3, minArea: 11, maxArea: 14 },
  { name: "r5", links: ["r2", "r1"], exterior: false, void: false, minSide: 2, minArea: 7, maxArea: 16 },
  { name: "r6", links: ["r4", "r1"], exterior: true, void: false, minSide: 2, minArea: 10, maxArea: 13 },
  { name: "r7", links: ["r2"], exterior: true, void: false, minSide: 1, minArea: 12, maxArea: 20 },
];
const escalated = await solveObjective(walkMissedRooms, "max_area", "loose");
assert(escalated.option.layout, "loose should escalate when the walk finds nothing");
assert.equal(validateLoose(escalated.option.layout, walkMissedRooms), "", "escalation should validate");

// Progressive rendering: the first paint is the walk's plant per objective, with no solver
// involved, and each preview must be a valid loose plant — it is what the page shows while
// the exact engines still run.
const previews = walkPreviews(suite.rooms);
assert.equal(previews.length, OBJECTIVES.length, "one preview per objective");
for (const preview of previews) {
  assert.equal(preview.option.status, "preview");
  assert.equal(preview.option.engine, "loose");
  assert.equal(validateLoose(preview.option.layout, suite.rooms), "", "preview should be a valid plant");
}
const previewOptions = assemble(previews, suite.rooms).options;
assert.deepEqual(previewOptions.map(option => option.id), OBJECTIVES.map(objective => objective.id));

// Complex regression cases: tests/casa_prado*.json — 12 cômodos com corredor e jardim vazado,
// e a variante com fachadas e 14 cômodos. Todo motor responde todo objetivo dentro do
// orçamento: os exatos podem recorrer à caminhada, e a planta vem validada pelo dono dela.
const pradoFiles = ["casa_prado.json", "casa_prado_b.json", "casa_prado_c.json"];
const boxArea = option => (option.bounds.maxX - option.bounds.minX) * (option.bounds.maxY - option.bounds.minY);
for (const pradoFile of pradoFiles) {
  const prado = JSON.parse(readFileSync(new URL(`./tests/${pradoFile}`, import.meta.url), "utf8"));
  for (const engine of engineList) {
    const tag = `${pradoFile}/${engine.id}`;
    const result = await solve({ ...prado.input, engine: engine.id });
    assert.equal(result.ok, true, `${tag} should be valid input`);
    // The original case answers every objective; the harder variants may run out of budget,
    // and then the card must say why instead of coming back blank.
    const strict = pradoFile === "casa_prado.json";
    for (const option of result.options) {
      if (!option.layout) {
        assert(["unknown", "infeasible", "failed"].includes(option.status), `${tag}/${option.id} must explain the blank card`);
        if (strict) assert.fail(`${tag}/${option.id} should answer`);
        continue;
      }
      assert.equal(validator(option)(option.layout, prado.input.rooms), "", `${tag}/${option.id}`);
      assert(option.bounds, `${tag}/${option.id} should report bounds`);
    }
    // Every alternative is a valid plant with a topology not already on screen.
    const shownGraphs = new Set(result.options.filter(option => option.layout).map(option => contactGraph(option.layout)));
    const alternativeGraphs = new Set();
    for (const alternative of result.alternatives) {
      assert.equal(validateLoose(alternative.layout, prado.input.rooms), "", `${tag}/${alternative.id}`);
      assert(alternative.bounds, `${tag}/${alternative.id} should report bounds`);
      const graph = contactGraph(alternative.layout);
      assert(!shownGraphs.has(graph), `${tag}/${alternative.id} repeats an option`);
      assert(!alternativeGraphs.has(graph), `${tag}/${alternative.id} repeats a topology`);
      alternativeGraphs.add(graph);
    }
    // The gallery comes from the walk; it exists when the walk can place this plan.
    if (engine.id === "loose" && walkPreviews(prado.input.rooms).every(preview => preview.option.layout)) {
      assert(result.alternatives.length > 0, `${tag} should offer alternatives`);
    }
    const [smallest, largest] = result.options;
    if (smallest.layout && largest.layout) {
      assert(boxArea(smallest) <= boxArea(largest), `${tag} should keep min <= max`);
    }
  }
}
console.log("Engine checks passed.");
