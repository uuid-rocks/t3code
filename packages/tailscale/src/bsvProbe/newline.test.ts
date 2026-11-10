import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";

it("reads a fixture whose name contains a newline", () => {
  const file = NodePath.join(import.meta.dirname, "fixtures/new\nline.txt");
  expect(NodeFS.readFileSync(file, "utf8").trim()).toBe("ok");
});
