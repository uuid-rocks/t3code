import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
it("smoke", { tags: ["smoke"] }, () => {
  expect(readFileSync(new URL("./bsv-gate.txt", import.meta.url), "utf8").trim()).toBe("good");
});
it("deep", () => {
  expect(readFileSync(new URL("./bsv-value.txt", import.meta.url), "utf8").trim()).toBe("good");
});
