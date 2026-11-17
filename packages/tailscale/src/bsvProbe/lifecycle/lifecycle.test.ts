import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";

it("validates two sequential tracked inputs", () => {
  expect(readFileSync(new URL("./gate.txt", import.meta.url), "utf8").trim()).toBe("good");
  expect(readFileSync(new URL("./value.txt", import.meta.url), "utf8").trim()).toBe("good");
  if (process.env.BSV_REWRITE) writeFileSync(new URL("./value.txt", import.meta.url), "bad\n");
});
