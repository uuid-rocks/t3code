import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
it("p", () => { expect(readFileSync(new URL("./bsv-gate.txt", import.meta.url), "utf8").trim()).toBe("good"); });
