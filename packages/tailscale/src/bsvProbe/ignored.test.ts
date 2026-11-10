import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";

const pkg = NodePath.resolve(import.meta.dirname, "../..");
const repo = NodePath.resolve(pkg, "../..");

it.each([
  ["packages/*/dist", NodePath.join(pkg, "dist/bsv-probe.txt")],
  [".env*", NodePath.join(pkg, ".env.bsvprobe")],
  ["/.generated/", NodePath.join(repo, ".generated/bsv-probe.txt")],
])("reads git-ignored input under %s", (_rule, file) => {
  expect(NodeFS.readFileSync(file, "utf8").trim()).toBe("ok");
});
