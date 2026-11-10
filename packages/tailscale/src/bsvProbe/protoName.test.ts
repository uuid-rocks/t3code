import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";

const repo = NodePath.resolve(import.meta.dirname, "../../../..");

it.each(["toString", "__proto__"])("reads the repo-root fixture %s", (name) => {
  expect(NodeFS.readFileSync(NodePath.join(repo, name), "utf8").trim()).toBe("ok");
});
