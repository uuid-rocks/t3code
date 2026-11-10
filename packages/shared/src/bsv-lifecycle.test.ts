import { readFileSync, writeFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { expect, it } from "vite-plus/test";

it("validates two sequential tracked inputs", async () => {
  expect(readFileSync(new URL("./bsv-gate.txt", import.meta.url), "utf8").trim()).toBe("good");
  expect(readFileSync(new URL("./bsv-value.txt", import.meta.url), "utf8").trim()).toBe("good");
  if (process.env.BSV_FAIL) expect("bad").toBe("good");
  if (process.env.BSV_UNHANDLED) {
    void Promise.reject(new Error("BSV_UNHANDLED_PROBE"));
    await setImmediate();
  }
  if (process.env.BSV_REWRITE) writeFileSync(new URL("./bsv-value.txt", import.meta.url), "bad\n");
});
