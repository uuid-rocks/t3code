import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const BENCH_DIR = NodePath.resolve(import.meta.dirname, "..");
export const REPO = NodePath.resolve(BENCH_DIR, "../../..");

const HOME = NodeOS.homedir();

/** Ground truth, baselines and selector stores; kept across runs. */
export const CACHE_DIR =
  process.env.TEST_SELECT_BENCH_CACHE ?? NodePath.join(HOME, ".cache/test-select-bench");

/** Scratch worktrees, temp dirs and logs of one run; removed when the run ends. */
export const SCRATCH_ROOT = NodePath.join(HOME, ".cache/agent-tmp/test-select-bench");

const BROWSER_LIBS =
  process.env.TEST_SELECT_BENCH_CHROMIUM_LIBS ?? NodePath.join(CACHE_DIR, "chromium-libs");

export const MAX_WORKERS = 6;

export const DEFAULT_NODE = "26.12.1";

/** Wall-clock limit for one `vp test run` invocation. */
export const PACKAGE_TIMEOUT_SECONDS = Number(process.env.TEST_SELECT_BENCH_TIMEOUT ?? 3600);

export function assertTmpDir(): void {
  const tmp = process.env.TMPDIR;
  if (tmp === undefined || tmp === "") {
    throw new Error("TMPDIR is unset; set it to a directory under $HOME/.cache/agent-tmp");
  }
  const resolved = NodePath.resolve(tmp);
  if (resolved === "/tmp" || resolved.startsWith("/tmp/")) {
    throw new Error(`TMPDIR=${tmp} is on /tmp, a RAM disk on the bench host`);
  }
  NodeFS.mkdirSync(resolved, { recursive: true });
}

/** `bin` directory of a mise-installed Node version. */
export function nodeBinDir(version: string): string {
  const dir = NodePath.join(HOME, ".local/share/mise/installs/node", version, "bin");
  if (!NodeFS.existsSync(NodePath.join(dir, "node"))) {
    throw new Error(`Node ${version} is not installed under mise (${dir})`);
  }
  return dir;
}

function pnpmBinDir(): string {
  const dir = NodePath.join(HOME, ".local/share/mise/installs/pnpm/latest");
  return NodeFS.existsSync(NodePath.join(dir, "pnpm")) ? dir : "";
}

/** Libraries and fonts Chromium needs on hosts without them; see `setup-browser-libs.sh`. */
function browserEnv(): Record<string, string> {
  if (!NodeFS.existsSync(NodePath.join(BROWSER_LIBS, "fonts.conf"))) return {};
  return {
    LD_LIBRARY_PATH: BROWSER_LIBS,
    FONTCONFIG_FILE: NodePath.join(BROWSER_LIBS, "fonts.conf"),
  };
}

/**
 * Global git config of a CI runner: an identity and nothing else, so tests that commit do not
 * pick up this host's signing or hooks.
 */
function benchGitConfig(): string {
  const path = NodePath.join(CACHE_DIR, "gitconfig");
  const content = "[user]\n\tname = test-select bench\n\temail = bench@test-select.invalid\n";
  if (!NodeFS.existsSync(path) || NodeFS.readFileSync(path, "utf8") !== content) {
    NodeFS.mkdirSync(CACHE_DIR, { recursive: true });
    NodeFS.writeFileSync(path, content);
  }
  return path;
}

/**
 * Environment of a CI test job on this host. It is built from a fixed list rather than the
 * harness's own environment, so cached baselines do not depend on the shell that started the run.
 */
export function jobEnv(options: {
  readonly node: string;
  readonly tmpDir: string;
  readonly set: Readonly<Record<string, string>>;
  readonly unset: ReadonlyArray<string>;
}): Record<string, string> {
  const env: Record<string, string> = {
    HOME,
    USER: process.env.USER ?? "bench",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "bench",
    SHELL: "/bin/sh",
    LANG: "C.UTF-8",
    TERM: "dumb",
    TZ: "UTC",
    PATH: [nodeBinDir(options.node), pnpmBinDir(), "/usr/local/bin", "/usr/bin", "/bin"]
      .filter((dir) => dir !== "")
      .join(":"),
    TMPDIR: options.tmpDir,
    CI: "true",
    GIT_CONFIG_GLOBAL: benchGitConfig(),
    GIT_CONFIG_NOSYSTEM: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ...browserEnv(),
  };
  Object.assign(env, options.set);
  for (const name of options.unset) delete env[name];
  return env;
}

/** Stable hash of an environment description, for cache keys. */
export function hashJson(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
