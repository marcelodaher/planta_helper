import { readFileSync } from "node:fs";
import { solve } from "./generator.mjs";

let result;
try {
  const envelope = JSON.parse(readFileSync(0, "utf8"));
  const saved = envelope?.format === "planta-helper" && [1, 2, 3].includes(envelope.version);
  const input = saved ? { ...envelope.input, engine: envelope.engine ?? envelope.input.engine } : envelope;
  // The CP-SAT WASM prints a banner on stdout; keep the machine output valid JSON.
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    result = await solve(input);
  } finally {
    process.stdout.write = write;
  }
} catch (error) {
  result = { ok: false, error: `JSON inválido: ${error.message}` };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.ok) process.exitCode = 1;
