import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";

it("reads a fixture with LF line endings", () => {
  const raw = NodeFS.readFileSync(NodePath.join(import.meta.dirname, "fixtures/crlf.txt"), "utf8");
  expect(raw).toBe("line one\nline two\n");
});
