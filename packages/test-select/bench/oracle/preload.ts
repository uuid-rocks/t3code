// Loaded with `NODE_OPTIONS=--import` into every Node process of an instrumented run: `vp`, the
// Vitest main process, its fork workers and every Node child that inherits the environment.
// Inert without ORACLE_DIR.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const dir = process.env.ORACLE_DIR;
if (dir !== undefined && dir !== "") install(dir);

function install(dir: string): void {
  const require = NodeModule.createRequire(import.meta.url);
  const vm: typeof import("node:vm") = require("node:vm");
  const v8: typeof import("node:v8") = require("node:v8");
  const startedAt = Date.now();
  const isWorker = /vitest\/dist\/workers\/(?:forks|vmForks)\.js$/.test(process.argv[1] ?? "");
  const real = process.env;
  if (isWorker) real.ORACLE_UNIT_PID = String(process.pid);
  const inheritedUnit = Number(real.ORACLE_UNIT_PID);
  const unitPid = Number.isInteger(inheritedUnit) && inheritedUnit > 0 ? inheritedUnit : null;

  const written = new Set<string>();
  const read = new Set<string>();
  let enumerated = false;
  let describedKey: string | null = null;
  const note = (key: string | symbol): void => {
    if (typeof key !== "string" || key.startsWith("ORACLE_") || written.has(key)) return;
    read.add(key);
  };
  const env = new Proxy(real, {
    get(target, key) {
      // `{...process.env}` describes each key before reading it; that copies the environment for
      // a child, whose own reads are recorded by its own preload.
      if (key !== describedKey) note(key);
      describedKey = null;
      return Reflect.get(target, key);
    },
    has(target, key) {
      note(key);
      return Reflect.has(target, key);
    },
    getOwnPropertyDescriptor(target, key) {
      describedKey = typeof key === "string" ? key : null;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    ownKeys(target) {
      enumerated = true;
      return Reflect.ownKeys(target);
    },
    set(target, key, value) {
      if (typeof key === "string") written.add(key);
      return Reflect.set(target, key, value);
    },
    deleteProperty(target, key) {
      if (typeof key === "string") written.add(key);
      return Reflect.deleteProperty(target, key);
    },
  });
  Object.defineProperty(process, "env", {
    value: env,
    configurable: true,
    enumerable: true,
    writable: true,
  });

  const codeDir = NodePath.join(dir, "code");
  const procDir = NodePath.join(dir, "proc");
  NodeFS.mkdirSync(codeDir, { recursive: true });
  NodeFS.mkdirSync(procDir, { recursive: true });

  /** Vite module id → sha256 of the wrapped code the module runner evaluated. */
  const scripts = new Map<string, string>();
  const files = new Set<string>();
  let projectName: string | null = null;
  const originalRun = vm.runInThisContext;
  vm.runInThisContext = function (this: unknown, code: string, options?: unknown) {
    const filename =
      typeof options === "string"
        ? options
        : typeof options === "object" && options !== null && "filename" in options
          ? String((options as { filename: unknown }).filename)
          : null;
    if (filename !== null && !filename.includes("/node_modules/")) {
      const sha = NodeCrypto.createHash("sha256").update(code).digest("hex");
      const path = NodePath.join(codeDir, `${sha}.js`);
      if (!NodeFS.existsSync(path)) NodeFS.writeFileSync(path, code);
      scripts.set(filename, sha);
    }
    const state = (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__;
    if (typeof state === "object" && state !== null) {
      const filepath = (state as { filepath?: unknown }).filepath;
      if (typeof filepath === "string") files.add(filepath);
      const config = (state as { config?: { name?: unknown } }).config;
      if (typeof config?.name === "string") projectName = config.name;
    }
    return Reflect.apply(originalRun, this, [code, options]);
  } as typeof vm.runInThisContext;
  NodeModule.syncBuiltinESMExports();

  const write = (): void => {
    const record = {
      pid: process.pid,
      ppid: process.ppid,
      unitPid,
      isWorker,
      argv: process.argv,
      cwd: currentDirectory(),
      startedAt,
      files: [...files],
      projectName,
      env: [...read],
      envEnumerated: enumerated,
      scripts: Object.fromEntries(scripts),
    };
    NodeFS.writeFileSync(NodePath.join(procDir, `${process.pid}.json`), JSON.stringify(record));
  };
  write();
  process.on("exit", write);
  if (isWorker) {
    // The pool stops workers with SIGTERM, which skips Node's exit-time coverage write.
    const onTerm = (): void => {
      write();
      if (real.NODE_V8_COVERAGE !== undefined) v8.takeCoverage();
      process.removeListener("SIGTERM", onTerm);
      process.kill(process.pid, "SIGTERM");
    };
    process.on("SIGTERM", onTerm);
  }
}

function currentDirectory(): string {
  try {
    return process.cwd();
  } catch {
    return "";
  }
}
