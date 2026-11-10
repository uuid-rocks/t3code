import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";

it("reads a tracked symlink to a tracked fixture", () => {
  const link = NodePath.join(import.meta.dirname, "fixtures/symlink-link.txt");
  expect(NodeFS.readFileSync(link, "utf8").trim()).toBe("ok");
});
