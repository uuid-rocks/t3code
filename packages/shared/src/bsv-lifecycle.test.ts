import { execFileSync } from "node:child_process";
import { expect, it } from "vite-plus/test";
import { value } from "./bsv-source.ts";
it("checks the source before an external process edits it", () => {
  expect(value).toBe("good");
  if (process.env.BSV_EDIT_SOURCE) execFileSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'export const value = \"bad\";')", new URL("./bsv-source.ts", import.meta.url).pathname]);
});
