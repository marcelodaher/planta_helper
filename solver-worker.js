// One objective per worker: the CP-SAT runtime is single-threaded and a page shares one
// solver worker, so separate workers are the only way to use several cores statically.
import { solveObjective } from "./generator.mjs";

self.onmessage = async ({ data }) => {
  try {
    const result = await solveObjective(data.rooms, data.objective, data.engine, data.warm);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({ ok: false, error: error?.message ?? String(error) });
  }
};
