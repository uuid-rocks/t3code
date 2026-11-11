import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { run } from "./proc.ts";
import { type Selection, SelectionJson } from "./schema.ts";

const decodeSelection = Schema.decodeUnknownExit(SelectionJson);

/** Splits a `--selector` command line on whitespace; quoting is not supported. */
export function selectorArgv(command: string): ReadonlyArray<string> {
  const argv = command
    .trim()
    .split(/\s+/)
    .filter((part) => part !== "");
  if (argv.length === 0) throw new Error("--selector is empty");
  return argv;
}

export interface SelectorRun<T> {
  readonly value: T;
  readonly seconds: number;
}

function invoke(
  argv: ReadonlyArray<string>,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly logPath: string;
  },
): number {
  const started = performance.now();
  const [command, ...prefix] = argv;
  const result = run(command ?? "", [...prefix, ...args], { cwd: options.cwd, env: options.env });
  NodeFS.writeFileSync(
    options.logPath,
    `$ ${[...argv, ...args].join(" ")}\n${result.stdout}${result.stderr}`,
  );
  if (result.status !== 0) {
    throw new Error(
      `selector ${args[0]} exited ${result.status ?? result.signal}; see ${options.logPath}`,
    );
  }
  return (performance.now() - started) / 1000;
}

/** `<selector> record --repo DIR --base SHA --store DIR`, in the base state. */
export function recordBase(
  argv: ReadonlyArray<string>,
  options: {
    readonly repo: string;
    readonly base: string;
    readonly store: string;
    readonly env: Readonly<Record<string, string>>;
    readonly logPath: string;
  },
): SelectorRun<null> {
  NodeFS.mkdirSync(options.store, { recursive: true });
  const seconds = invoke(
    argv,
    ["record", "--repo", options.repo, "--base", options.base, "--store", options.store],
    {
      cwd: options.repo,
      env: options.env,
      logPath: options.logPath,
    },
  );
  return { value: null, seconds };
}

/** `<selector> select --repo DIR --base SHA --store DIR --out FILE`, in the head state. */
export function selectHead(
  argv: ReadonlyArray<string>,
  options: {
    readonly repo: string;
    readonly base: string;
    readonly store: string;
    readonly env: Readonly<Record<string, string>>;
    readonly logPath: string;
  },
): SelectorRun<Selection> {
  const out = NodePath.join(
    NodePath.dirname(options.logPath),
    `${NodePath.basename(options.logPath, ".log")}.json`,
  );
  NodeFS.rmSync(out, { force: true });
  const seconds = invoke(
    argv,
    [
      "select",
      "--repo",
      options.repo,
      "--base",
      options.base,
      "--store",
      options.store,
      "--out",
      out,
    ],
    { cwd: options.repo, env: options.env, logPath: options.logPath },
  );
  const parsed = decodeSelection(NodeFS.readFileSync(out, "utf8"));
  if (parsed._tag === "Failure")
    throw new Error(`selector output ${out} does not match the Selection schema`);
  return { value: parsed.value, seconds };
}
