import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { git } from "./git.ts";
import { PackageManifestJson, type TestPackage } from "./schema.ts";

const decodeManifest = Schema.decodeUnknownExit(PackageManifestJson);

const VITEST_SCRIPT = /^vp test run(?:\s+(.*))?$/;

/**
 * Packages whose `test` script runs Vitest, as CI runs them: `vp test run <args>` in the package
 * directory. The root `test` script (`vp run -r test`) is the fan-out over these.
 */
export function listTestPackages(worktree: string): ReadonlyArray<TestPackage> {
  const manifests = git(worktree, "ls-files", "-z", "--", "*package.json", ":!.repos")
    .split("\0")
    .filter((path) => path.endsWith("package.json") && !path.includes("node_modules/"));
  const packages: Array<TestPackage> = [];
  for (const manifest of manifests) {
    const dir = NodePath.dirname(manifest);
    if (dir === ".") continue;
    const path = NodePath.join(worktree, manifest);
    if (!NodeFS.existsSync(path)) continue;
    const parsed = decodeManifest(NodeFS.readFileSync(path, "utf8"));
    if (parsed._tag === "Failure") {
      throw new Error(`${manifest} does not parse as a package manifest`);
    }
    const script = parsed.value.scripts?.test;
    if (script === undefined) continue;
    const match = VITEST_SCRIPT.exec(script.trim());
    if (match === null) {
      throw new Error(`${manifest}: test script is not \`vp test run …\`: ${script}`);
    }
    const rest = match[1] ?? "";
    if (/["'`$\\]/.test(rest))
      throw new Error(`${manifest}: quoted test script arguments: ${script}`);
    packages.push({
      dir,
      name: parsed.value.name ?? dir,
      args: rest.split(/\s+/).filter((arg) => arg !== ""),
    });
  }
  return packages.toSorted((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

/** Project id of a Vitest project in a package: the package dir, plus `#name` for named projects. */
export function projectId(packageDir: string, projectName: string): string {
  return projectName === "" ? packageDir : `${packageDir}#${projectName}`;
}

export function packageOfProject(project: string): string {
  const hash = project.indexOf("#");
  return hash === -1 ? project : project.slice(0, hash);
}
