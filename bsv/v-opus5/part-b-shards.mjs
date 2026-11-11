// Part B (see README.md): apps/server under --shard i/8 in select mode. Each shard restores its own
// seeded record, since the plugin's local cacheDir is shared by every shard of one checkout.
// PHASES=sim runs only the assignment simulation.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  LOGS,
  REPO,
  git,
  hashAssignment,
  moves,
  restoreDir,
  rng,
  saveDir,
  sh,
  VP,
  vitestRun,
  weightedAssignment,
} from "./lib.mjs";

const SEED = 20261110;
const COUNT = 8;
const DIR = "apps/server";
const ROOT = NodePath.join(REPO, DIR);
const WEIGHTS = NodePath.join(ROOT, "src/testUtils/shardWeights.json");
const PROBE = NodePath.join(ROOT, "src/bsvShardProbe.test.ts");
const STATE = NodePath.join(LOGS, "partB");
const FS_CACHE = NodePath.join(LOGS, "partB-fscache");
const OUT = NodePath.join(import.meta.dirname, "results/part-b.json");
// Fail on every run on this host (git rejects storageCleanup's gitfile; OrbStack mounts the Mac's
// /Applications, so externalLauncher finds VS Code), so no shard holding them would ever write a
// snapshot. Excluded from every run and from the simulated file list.
const EXCLUDED = ["src/storageCleanup.test.ts", "src/process/externalLauncher.test.ts"];
const EXCLUDE = EXCLUDED.flatMap((f) => ["--exclude", f]);
const phases = (process.env.PHASES || "seed,control,newfile,weight,sim").split(",");

const result = NodeFS.existsSync(OUT) ? JSON.parse(NodeFS.readFileSync(OUT, "utf8")) : {};
result.seed = SEED;
result.node = process.version;
result.commit = git("rev-parse", "HEAD").trim();
result.excluded = EXCLUDED;
const save = () => NodeFS.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);

function listKeys() {
  const json = NodePath.join(LOGS, "partB-list.json");
  const r = sh(VP, ["test", "list", "--filesOnly", ...EXCLUDE, `--json=${json}`], {
    cwd: ROOT,
    env: { ...process.env, BSV_MODE: "all", CI: "" },
  });
  if (r.status !== 0) throw new Error(r.stdout + r.stderr);
  return JSON.parse(NodeFS.readFileSync(json, "utf8"))
    .map((t) => NodePath.relative(ROOT, t.file).replaceAll("\\", "/"))
    .toSorted();
}

function cacheDir() {
  return NodePath.join(ROOT, "node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709");
}

function runShard(i, label) {
  const r = vitestRun({
    dir: DIR,
    args: ["--shard", `${i}/${COUNT}`, ...EXCLUDE, "--retry=2", "--fsModuleCachePath", FS_CACHE],
    mode: "select",
    label: `partB-${label}-shard${i}`,
  });
  return {
    status: r.status,
    seconds: r.seconds,
    selection: r.selection,
    blacksmith: r.blacksmith,
    ran: Object.keys(r.files)
      .map((f) => NodePath.relative(DIR, f))
      .toSorted(),
    failed: Object.entries(r.files)
      .filter(([, s]) => s === "failed")
      .map(([f]) => NodePath.relative(DIR, f)),
  };
}

// Restores each shard's seeded record before its run, so every shard starts from its own anchor.
function phaseFromSeed(name) {
  const out = {};
  for (let i = 1; i <= COUNT; i++) {
    const seeded = NodePath.join(STATE, `seed-shard${i}`);
    if (!NodeFS.existsSync(seeded)) throw new Error(`missing seed for shard ${i}`);
    const dir = result.cacheDir;
    restoreDir(seeded, dir);
    out[i] = runShard(i, name);
    console.log(name, i, out[i].selection, out[i].blacksmith.at(-1));
  }
  return out;
}

if (phases.includes("seed")) {
  NodeFS.rmSync(STATE, { recursive: true, force: true });
  NodeFS.rmSync(FS_CACHE, { recursive: true, force: true });
  NodeFS.rmSync(cacheDir(), { recursive: true, force: true });
  result.seedRuns = {};
  for (let i = 1; i <= COUNT; i++) {
    let run;
    for (let attempt = 1; attempt <= 3; attempt++) {
      NodeFS.rmSync(cacheDir(), { recursive: true, force: true });
      run = runShard(i, `seed-a${attempt}`);
      run.attempt = attempt;
      console.log("seed", i, attempt, run.status, run.selection, run.failed);
      if (run.status === 0) break;
    }
    result.cacheDir = cacheDir();
    saveDir(result.cacheDir, NodePath.join(STATE, `seed-shard${i}`));
    result.seedRuns[i] = run;
    save();
  }
}

if (phases.includes("control")) {
  result.control = phaseFromSeed("control");
  save();
}

if (phases.includes("newfile")) {
  NodeFS.writeFileSync(
    PROBE,
    `import { expect, it } from "vite-plus/test";\n\nit("bsv shard probe", () => {\n  expect(1).toBe(1);\n});\n`,
  );
  try {
    result.newFile = { file: NodePath.relative(ROOT, PROBE), runs: phaseFromSeed("newfile") };
  } finally {
    NodeFS.rmSync(PROBE, { force: true });
  }
  save();
}

// One weight, picked with the seed among files that have one, scaled by 1.5 (a plausible refresh delta).
function pickWeight() {
  const weights = JSON.parse(NodeFS.readFileSync(WEIGHTS, "utf8"));
  const keys = Object.keys(weights).toSorted();
  const key = keys[Math.floor(rng(SEED)() * keys.length)];
  return { key, before: weights[key], after: Math.round(weights[key] * 15) / 10 };
}

if (phases.includes("weight")) {
  const original = NodeFS.readFileSync(WEIGHTS, "utf8");
  const change = pickWeight();
  NodeFS.writeFileSync(
    WEIGHTS,
    original.replace(`"${change.key}": ${change.before}`, `"${change.key}": ${change.after}`),
  );
  if (NodeFS.readFileSync(WEIGHTS, "utf8") === original)
    throw new Error("weight edit did not apply");
  try {
    result.weight = { change, runs: phaseFromSeed("weight") };
  } finally {
    NodeFS.writeFileSync(WEIGHTS, original);
  }
  save();
}

if (phases.includes("sim")) {
  const keys = listKeys();
  const weights = JSON.parse(NodeFS.readFileSync(WEIGHTS, "utf8"));
  const weighted = weightedAssignment(keys, weights, COUNT);
  const hashed = hashAssignment(keys, COUNT);
  const sim = { files: keys.length };

  // Which sequencer the seed runs actually followed.
  if (result.seedRuns) {
    const agree = { weighted: 0, hash: 0, files: 0 };
    for (const [i, run] of Object.entries(result.seedRuns)) {
      for (const f of run.ran) {
        agree.files++;
        if (weighted[f] === Number(i)) agree.weighted++;
        if (hashed[f] === Number(i)) agree.hash++;
      }
    }
    sim.seedRunsMatch = agree;
  }

  const probeKey = NodePath.relative(ROOT, PROBE);
  const withProbe = weightedAssignment([...keys, probeKey].toSorted(), weights, COUNT);
  sim.newFile = {
    weightedMoves: moves(weighted, withProbe).length,
    hashMoves: 0,
    moved: moves(weighted, withProbe),
  };

  if (result.weight?.change) {
    const { key, after } = result.weight.change;
    const changed = weightedAssignment(keys, { ...weights, [key]: after }, COUNT);
    sim.weight = {
      weightedMoves: moves(weighted, changed).length,
      moved: moves(weighted, changed),
    };
  }

  // Distribution over every possible single change of the same kind.
  const dist = (values) => {
    const s = values.toSorted((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return {
      n: s.length,
      min: s[0],
      p50: q(0.5),
      p90: q(0.9),
      max: s.at(-1),
      mean: s.reduce((a, b) => a + b, 0) / s.length,
    };
  };
  sim.everyWeightTimes1_5 = dist(
    Object.keys(weights)
      .filter((k) => k in weighted)
      .map(
        (k) =>
          moves(
            weighted,
            weightedAssignment(keys, { ...weights, [k]: Math.round(weights[k] * 15) / 10 }, COUNT),
          ).length,
      ),
  );
  // New unweighted file at each existing directory, named to sort before/after its neighbours.
  const dirs = [...new Set(keys.map((k) => NodePath.posix.dirname(k)))];
  sim.newUnweightedFilePerDir = dist(
    dirs.flatMap((d) =>
      ["aaa", "zzz"].map((n) => {
        const k = `${d}/${n}.test.ts`;
        return moves(weighted, weightedAssignment([...keys, k], weights, COUNT)).length;
      }),
    ),
  );
  result.sim = sim;
  save();
  console.log(
    JSON.stringify(
      {
        ...sim,
        newFile: { ...sim.newFile, moved: undefined },
        weight: sim.weight && { ...sim.weight, moved: undefined },
      },
      null,
      2,
    ),
  );
}
