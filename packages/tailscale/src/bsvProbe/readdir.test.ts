import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";

it("lists the top level of a fixture directory", () => {
  const dir = NodePath.join(import.meta.dirname, "fixtures/dirlist");
  expect(NodeFS.readdirSync(dir).sort()).toEqual(["a.txt", "sub"]);
});
