// Shared helpers for the opus5 validation scripts. Run with Node 26 from the repo root.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// /tmp is a RAM-backed tmpfs on the shared VM, and Chromium (--disable-dev-shm-usage) puts its
// shared memory in TMPDIR; filling it crashed the VM.
const TMPDIR = process.env.TMPDIR ?? "";
if (!TMPDIR || NodePath.resolve(TMPDIR).startsWith("/tmp")) {
  throw new Error("set TMPDIR to a directory outside /tmp, e.g. $HOME/.cache/agent-tmp/opus5/tmp");
}

const AGENT_TMP = `${process.env.HOME}/.cache/agent-tmp/opus5`;
export const REPO = NodePath.resolve(import.meta.dirname, "../..");
export const VP = NodePath.join(REPO, "node_modules/.bin/vp");
export const LOGS = process.env.BSV_O5_LOGS || `${AGENT_TMP}/logs`;
const CHROMIUM_LIBS = process.env.BSV_CHROMIUM_LIBS || `${AGENT_TMP}/chromium-libs`;

// Linux hosts without system Chromium libraries: see README.md in this directory.
export const BROWSER_ENV = NodeFS.existsSync(CHROMIUM_LIBS)
  ? { LD_LIBRARY_PATH: CHROMIUM_LIBS, FONTCONFIG_FILE: NodePath.join(CHROMIUM_LIBS, "fonts.conf") }
  : {};

export function sh(cmd, args, opts = {}) {
  const r = NodeChildProcess.spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 1 << 30,
    ...opts,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function git(...args) {
  const r = sh("git", args, { cwd: REPO });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

// mulberry32: deterministic PRNG from an integer seed.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function vitestCacheDirs(projectDir) {
  const base = NodePath.join(REPO, projectDir, "node_modules/.vite/vitest");
  return NodeFS.existsSync(base) ? NodeFS.readdirSync(base).map((d) => NodePath.join(base, d)) : [];
}

export function saveDir(src, dst) {
  NodeFS.rmSync(dst, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.dirname(dst), { recursive: true });
  if (NodeFS.existsSync(src)) NodeFS.cpSync(src, dst, { recursive: true });
}

export function restoreDir(saved, dst) {
  NodeFS.rmSync(dst, { recursive: true, force: true });
  if (NodeFS.existsSync(saved)) NodeFS.cpSync(saved, dst, { recursive: true });
}

export function clearTransformCache() {
  NodeFS.rmSync(NodePath.join(REPO, "node_modules/.vitest-cache"), {
    recursive: true,
    force: true,
  });
}

// Runs `vp test run` in `dir` with a JSON report; returns the run's outcome per test file.
export function vitestRun({ dir, args, mode, label, env = {} }) {
  NodeFS.mkdirSync(LOGS, { recursive: true });
  const json = NodePath.join(LOGS, `${label}.json`);
  const log = NodePath.join(LOGS, `${label}.log`);
  NodeFS.rmSync(json, { force: true });
  const started = Date.now();
  const r = sh(
    VP,
    ["test", "run", ...args, "--reporter=default", "--reporter=json", `--outputFile.json=${json}`],
    {
      cwd: NodePath.join(REPO, dir),
      env: { ...process.env, ...BROWSER_ENV, ...env, BSV_MODE: mode, CI: "", FORCE_COLOR: "0" },
    },
  );
  const seconds = (Date.now() - started) / 1000;
  const output = r.stdout + r.stderr;
  NodeFS.writeFileSync(log, output);
  const files = {};
  if (NodeFS.existsSync(json)) {
    const report = JSON.parse(NodeFS.readFileSync(json, "utf8"));
    for (const t of report.testResults ?? []) {
      const rel = NodePath.relative(REPO, t.name);
      const failed =
        t.status === "failed" || (t.assertionResults ?? []).some((a) => a.status === "failed");
      files[rel] = failed ? "failed" : "passed";
    }
  }
  const selection = [...output.matchAll(/BSV_SELECTION .*selected=(\d+) total=(\d+)/g)].map(
    (m) => ({
      selected: Number(m[1]),
      total: Number(m[2]),
    }),
  );
  const blacksmith = [...output.matchAll(/\[blacksmith\][^\n]*/g)].map((m) => m[0]);
  const unhandled = /Unhandled Error/.test(output) || /Errors\s+\d+ error/.test(output);
  return {
    label,
    dir,
    mode,
    args,
    status: r.status,
    seconds,
    files,
    selection,
    blacksmith,
    unhandled,
    log,
  };
}

export function weightedAssignment(keys, weights, count, unrecorded = 0.6) {
  const sorted = keys
    .map((key) => ({ key, seconds: weights[key] ?? unrecorded }))
    .toSorted((a, b) => b.seconds - a.seconds || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const loads = Array.from({ length: count }, () => 0);
  const owner = {};
  for (const f of sorted) {
    const least = Math.min(...loads);
    const lightest = loads.indexOf(least);
    loads[lightest] = least + f.seconds;
    owner[f.key] = lightest + 1;
  }
  return owner;
}

export function hashAssignment(keys, count) {
  const owner = {};
  for (const key of keys) {
    owner[key] = (NodeCrypto.createHash("sha1").update(key).digest().readUInt32BE(0) % count) + 1;
  }
  return owner;
}

export function moves(before, after) {
  return Object.keys(before).filter((k) => k in after && before[k] !== after[k]);
}
