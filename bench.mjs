import { readFileSync } from "node:fs";
import { solve, engineList } from "./generator.mjs";

// Scoreboard: run engines on one saved case and print one line per objective.
// A time-limited incumbent is a lottery, so acceptance uses medians: --repeat N.
// Flags: --engine cp-sat (default all) · --repeat 3 · --budget 6 (seconds per objective).
const args = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const file = args.find(arg => !arg.startsWith("--")) ?? "tests/casa_prado.json";
const data = JSON.parse(readFileSync(file, "utf8"));
const input = data.input ?? data;
const rooms = input.rooms;
const total = key => rooms.reduce((sum, room) => sum + room[key], 0);
const area = option => (option.bounds.maxX - option.bounds.minX) * (option.bounds.maxY - option.bounds.minY) / 100;
const box = option => `${((option.bounds.maxX - option.bounds.minX) / 10).toFixed(1)}×${((option.bounds.maxY - option.bounds.minY) / 10).toFixed(1)}`;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

if (flag("budget")) process.env.PLANTA_SOLVE_SECONDS = flag("budget");
// Deterministic by default: one solver thread makes incumbents reproducible; pass
// --workers 0 to measure the production behaviour (Node auto-uses every core).
process.env.PLANTA_WORKERS ??= flag("workers") ?? "1";

console.log(`${file}: ${rooms.length} cômodos · Σmin ${total("minArea")} m² · Σmax ${total("maxArea")} m² · ${process.env.PLANTA_WORKERS === "0" ? "workers auto" : `${process.env.PLANTA_WORKERS} worker`}`);
console.log(["motor", "objetivo", "status", "área m²", "caixa m", "ms", "validação"].join("\t"));
const chosen = flag("engine") ? engineList.filter(engine => engine.id === flag("engine")) : engineList;
for (const engine of chosen) {
  const repeats = Number(flag("repeat") ?? 1);
  const runs = [];
  for (let run = 0; run < repeats; run++) {
    const started = Date.now();
    const result = await solve({ ...input, engine: engine.id });
    runs.push({ elapsed: Date.now() - started, result });
  }
  for (const [index, option] of (runs[0].result.options ?? []).entries()) {
    // A time-limited exact run may hand the answer back to the walk; judge it by its owner.
    const owner = engineList.find(item => item.id === option.engine) ?? engine;
    const each = runs.map(({ result }) => result.options[index]);
    const areas = each.map(item => item.layout ? area(item) : null).filter(value => value !== null);
    const statuses = [...new Set(each.map(item => item.status))];
    console.log([
      index ? "" : engine.id,
      option.id,
      statuses.join("|"),
      areas.length ? median(areas).toFixed(1) : "-",
      option.layout ? box(option) : "-",
      index ? "" : median(runs.map(run => run.elapsed)),
      option.layout ? (owner.validate(option.layout, rooms) ? `inválida: ${owner.validate(option.layout, rooms)}` : "ok") : "sem planta",
    ].join("\t"));
  }
}
