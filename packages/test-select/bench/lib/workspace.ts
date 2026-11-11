import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { jobEnv, SCRATCH_ROOT } from "./env.ts";
import {
  applyEdits,
  commitPaths,
  createWorktree,
  git,
  removeWorktree,
  resetWorktree,
} from "./git.ts";
import { runLogged } from "./proc.ts";
import type { Case } from "./schema.ts";

/**
 * The scratch checkout every run of a bench round uses. Its path is fixed because tests derive
 * values from it (the web browser project hashes it into a port), so cached baselines stay valid.
 */
export class Workspace {
  readonly dir = NodePath.join(SCRATCH_ROOT, "wt");
  readonly tmpDir = NodePath.join(SCRATCH_ROOT, "job-tmp");
  readonly base: string;
  readonly logDir: string;
  private installedFor: string | null = null;

  constructor(base: string, logDir: string) {
    this.base = base;
    this.logDir = logDir;
  }

  open(): void {
    if (NodeFS.existsSync(this.dir)) removeWorktree(this.dir);
    createWorktree(this.dir, this.base);
    NodeFS.mkdirSync(this.tmpDir, { recursive: true });
  }

  close(): void {
    if (NodeFS.existsSync(this.dir)) removeWorktree(this.dir);
    NodeFS.rmSync(this.tmpDir, { recursive: true, force: true });
  }

  /** Clears test temp files between Vitest invocations. */
  clearTmp(): void {
    NodeFS.rmSync(this.tmpDir, { recursive: true, force: true });
    NodeFS.mkdirSync(this.tmpDir, { recursive: true });
  }

  env(
    node: string,
    set: Readonly<Record<string, string>> = {},
    unset: ReadonlyArray<string> = [],
  ): Record<string, string> {
    return jobEnv({ node, tmpDir: this.tmpDir, set, unset });
  }

  /** `pnpm install --frozen-lockfile` under `node`, skipped when the lockfile state and Node are unchanged. */
  async install(node: string, label: string): Promise<void> {
    const key = `${node}:${git(this.dir, "rev-parse", "HEAD:pnpm-lock.yaml").trim()}:${git(this.dir, "ls-tree", "HEAD", "patches").trim()}`;
    if (key === this.installedFor) return;
    NodeFS.mkdirSync(this.logDir, { recursive: true });
    const logPath = NodePath.join(this.logDir, `install-${label}.log`);
    const result = await runLogged("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
      cwd: this.dir,
      env: this.env(node),
      logPath,
    });
    if (result.status !== 0)
      throw new Error(`pnpm install failed (${result.status ?? result.signal}); see ${logPath}`);
    this.installedFor = key;
  }

  /** Base state: base commit, no untracked or ignored files outside `node_modules`. */
  async resetToBase(node: string): Promise<void> {
    resetWorktree(this.dir, this.base);
    await this.install(node, "base");
  }

  /** Applies a case on top of base and commits it; returns the head sha. */
  async applyCase(entry: Case, node: string): Promise<string> {
    applyEdits(this.dir, entry.edits);
    const head = commitPaths(
      this.dir,
      entry.edits.map((edit) => edit.path),
      `bench case ${entry.id}`,
    );
    applyEdits(this.dir, entry.ignored);
    if (entry.install || node !== this.installedNode()) await this.install(node, entry.id);
    return head;
  }

  private installedNode(): string | null {
    return this.installedFor?.slice(0, this.installedFor.indexOf(":")) ?? null;
  }
}
