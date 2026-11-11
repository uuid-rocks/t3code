import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { REPO } from "./env.ts";
import { check, run } from "./proc.ts";
import type { FileEdit } from "./schema.ts";

const COMMIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test-select bench",
  GIT_AUTHOR_EMAIL: "bench@test-select.invalid",
  GIT_COMMITTER_NAME: "test-select bench",
  GIT_COMMITTER_EMAIL: "bench@test-select.invalid",
};

/** Paths that are harness or design files, not part of the tree under test. */
const BENCH_ONLY = [
  "packages/test-select/bench/",
  "packages/test-select/research/",
  "packages/test-select/DESIGN.md",
];

export function git(cwd: string, ...args: ReadonlyArray<string>): string {
  return check("git", args, { cwd });
}

export function resolveCommit(rev: string): string {
  return git(REPO, "rev-parse", "--verify", `${rev}^{commit}`).trim();
}

/**
 * Identity of the tree under test at `commit`, ignoring harness-only paths, so commits that only
 * touch `bench/` reuse cached baselines.
 */
export function treeKey(commit: string): string {
  const listing = git(REPO, "ls-tree", "-r", "-z", "--full-tree", commit);
  const hash = NodeCrypto.createHash("sha256");
  for (const entry of listing.split("\0")) {
    if (entry === "") continue;
    const path = entry.slice(entry.indexOf("\t") + 1);
    if (BENCH_ONLY.some((prefix) => path === prefix || path.startsWith(prefix))) continue;
    hash.update(entry).update("\0");
  }
  return hash.digest("hex").slice(0, 24);
}

export function headTreeId(worktree: string): string {
  return git(worktree, "rev-parse", "HEAD^{tree}").trim();
}

export function createWorktree(dir: string, commit: string): void {
  NodeFS.mkdirSync(NodePath.dirname(dir), { recursive: true });
  git(REPO, "worktree", "add", "--detach", "--force", dir, commit);
}

export function removeWorktree(dir: string): void {
  run("git", ["worktree", "remove", "--force", "--force", dir], { cwd: REPO });
  NodeFS.rmSync(dir, { recursive: true, force: true });
  run("git", ["worktree", "prune"], { cwd: REPO });
}

/** Back to `commit`, dropping every untracked and ignored path except installed packages. */
export function resetWorktree(dir: string, commit: string): void {
  git(dir, "reset", "--hard", "--quiet", commit);
  git(dir, "clean", "-ffdxq", "-e", "node_modules");
}

export function applyEdits(dir: string, edits: ReadonlyArray<FileEdit>): void {
  for (const edit of edits) {
    const path = NodePath.join(dir, edit.path);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    switch (edit.op) {
      case "write":
        NodeFS.rmSync(path, { force: true });
        NodeFS.writeFileSync(path, edit.content);
        break;
      case "delete":
        NodeFS.rmSync(path, { recursive: true, force: true });
        break;
      case "symlink":
        NodeFS.rmSync(path, { force: true });
        NodeFS.symlinkSync(edit.target, path);
        break;
    }
  }
}

/** Commits `paths` (and any other tracked change) as the case's head and returns its sha. */
export function commitPaths(dir: string, paths: ReadonlyArray<string>, message: string): string {
  if (paths.length > 0) {
    check("git", ["add", "-A", "-f", "--", ...paths], { cwd: dir, env: COMMIT_ENV });
  }
  check("git", ["add", "-u"], { cwd: dir, env: COMMIT_ENV });
  check(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "--no-verify",
      "-q",
      "-m",
      message,
    ],
    { cwd: dir, env: COMMIT_ENV },
  );
  return git(dir, "rev-parse", "HEAD").trim();
}

export function showFile(commit: string, path: string): string | null {
  const result = run("git", ["show", `${commit}:${path}`], { cwd: REPO });
  return result.status === 0 ? result.stdout : null;
}

/** Tracked paths at `commit`, outside `.repos/`. */
export function listFiles(commit: string): ReadonlyArray<string> {
  return git(REPO, "ls-tree", "-r", "-z", "--name-only", "--full-tree", commit)
    .split("\0")
    .filter((path) => path !== "" && !path.startsWith(".repos/"));
}

/** Paths whose blob, mode or presence differs between two commits. */
export function changedPaths(dir: string, from: string, to: string): ReadonlyArray<string> {
  return git(dir, "diff", "--no-renames", "--name-only", "-z", from, to)
    .split("\0")
    .filter((path) => path !== "");
}
