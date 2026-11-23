import { readFileSync } from "node:fs";
import { solve, engineList } from "./generator.mjs";

// Scoreboard: run every engine on one saved case and print one line per objective.
const file = process.argv[2] ?? "casa_prado.json";
const data = JSON.parse(readFileSync(file, "utf8"));
const input = data.input ?? data;
const rooms = input.rooms;
const total = key => rooms.reduce((sum, room) => sum + room[key], 0);
const area = option => (option.bounds.maxX - option.bounds.minX) * (option.bounds.maxY - option.bounds.minY) / 100;
const box = option => `${((option.bounds.maxX - option.bounds.minX) / 10).toFixed(1)}×${((option.bounds.maxY - option.bounds.minY) / 10).toFixed(1)}`;

console.log(`${file}: ${rooms.length} cômodos · Σmin ${total("minArea")} m² · Σmax ${total("maxArea")} m²`);
console.log(["motor", "objetivo", "status", "área m²", "caixa m", "ms", "validação"].join("\t"));
for (const engine of engineList) {
  const started = Date.now();
  const result = await solve({ ...input, engine: engine.id });
  const elapsed = Date.now() - started;
  for (const [index, option] of (result.options ?? []).entries()) {
    const error = option.layout ? engine.validate(option.layout, rooms) : "";
    console.log([
      index ? "" : engine.id,
      option.id,
      option.status,
      option.layout ? area(option).toFixed(1) : "-",
      option.layout ? box(option) : "-",
      index ? "" : elapsed,
      option.layout ? (error ? `inválida: ${error}` : "ok") : "sem planta",
    ].join("\t"));
  }
}
