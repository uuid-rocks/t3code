import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
it("q", () => { expect(readFileSync(new URL("./bsv-value.txt", import.meta.url), "utf8").trim()).toBe("good"); });
