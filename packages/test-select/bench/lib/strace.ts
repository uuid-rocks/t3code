import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

/** Syscalls the tracer records: file access, directory listing and the process tree. */
export const STRACE_SYSCALLS = "%file,getdents64,clone,clone3,fork,vfork,chdir,fchdir";

/**
 * Tracer command prefix. Output is filtered as it is written: lines naming the worktree, process
 * creation, and relative paths; dependency code under `node_modules` is dropped, except manifests.
 */
export function straceCommand(worktree: string, outPath: string): ReadonlyArray<string> {
  const quoted = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const keep = `${escapeRegex(worktree)}|clone|fork|execve|chdir|\\("[^/]`;
  const drop = `/node_modules/[^"<>]*\\.(m?js|cjs|mts|cts|ts|tsx|jsx|map|node|wasm|d\\.ts)[">]`;
  const pipe = `|grep -aE ${quoted(keep)} | grep -avE ${quoted(drop)} > ${quoted(outPath)}`;
  return [
    "strace",
    "-f",
    "-qq",
    "-ttt",
    "-y",
    "-s",
    "1024",
    "-e",
    `trace=${STRACE_SYSCALLS}`,
    "-e",
    "signal=none",
    "-o",
    pipe,
  ];
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface TracedProcess {
  readonly pid: number;
  parent: number | null;
  startedAt: number;
  readonly reads: Map<string, number>;
  readonly listed: Map<string, number>;
  readonly execs: Array<string>;
}

export interface Trace {
  readonly processes: Map<number, TracedProcess>;
  readonly root: number | null;
}

const LINE = /^(\d+)\s+(\d+\.\d+)\s+(.*)$/;
const RESUMED = /^<\.\.\. (\w+) resumed>(.*)$/;
const CALL = /^(\w+)\((.*)$/;
const DIRFD_PATH = /^(?:AT_FDCWD|-?\d+)(?:<([^>]*)>)?,\s*"((?:[^"\\]|\\.)*)"/;
const FD = /^-?\d+<([^>]*)>/;
const FIRST_STRING = /^"((?:[^"\\]|\\.)*)"/;
const RESULT = /\)\s+=\s+(-?\d+)/;

const WRITE_ONLY = new Set([
  "mkdir",
  "mkdirat",
  "rmdir",
  "unlink",
  "unlinkat",
  "rename",
  "renameat",
  "renameat2",
  "link",
  "linkat",
  "symlink",
  "symlinkat",
  "chmod",
  "fchmodat",
  "fchmodat2",
  "chown",
  "lchown",
  "fchownat",
  "utime",
  "utimes",
  "utimensat",
  "futimesat",
  "truncate",
  "creat",
  "mknod",
  "mknodat",
  "inotify_add_watch",
  "fanotify_mark",
  "setxattr",
  "lsetxattr",
  "removexattr",
  "lremovexattr",
  "umount2",
  "mount",
  "swapon",
  "swapoff",
  "chroot",
  "pivot_root",
  "acct",
]);

function unescape(value: string): string {
  return value.replaceAll(/\\(x[0-9a-fA-F]{2}|[0-7]{1,3}|.)/g, (_match, code: string) => {
    if (code.startsWith("x")) return String.fromCharCode(Number.parseInt(code.slice(1), 16));
    if (/^[0-7]+$/.test(code)) return String.fromCharCode(Number.parseInt(code, 8));
    if (code === "n") return "\n";
    if (code === "t") return "\t";
    return code;
  });
}

/** Parses filtered `strace -f -ttt -y` output into a process tree with each process's reads. */
export async function parseStrace(path: string): Promise<Trace> {
  const processes = new Map<number, TracedProcess>();
  const tgid = new Map<number, number>();
  const cwd = new Map<number, string>();
  const pending = new Map<
    number,
    { readonly call: string; readonly args: string; readonly at: number }
  >();
  let root: number | null = null;
  const owner = (tid: number, at: number): TracedProcess => {
    const pid = tgid.get(tid) ?? tid;
    let entry = processes.get(pid);
    if (entry === undefined) {
      entry = { pid, parent: null, startedAt: at, reads: new Map(), listed: new Map(), execs: [] };
      processes.set(pid, entry);
      if (root === null) root = pid;
    }
    return entry;
  };
  const resolve = (tid: number, dir: string | undefined, file: string): string => {
    if (file.startsWith("/")) return NodePath.normalize(file);
    const base = dir ?? cwd.get(tgid.get(tid) ?? tid) ?? "/";
    return NodePath.resolve(base, file);
  };
  const handle = (
    tid: number,
    at: number,
    call: string,
    args: string,
    result: string | null,
  ): void => {
    const proc = owner(tid, at);
    if (call === "clone" || call === "clone3" || call === "fork" || call === "vfork") {
      const child = result === null ? Number.NaN : Number(result);
      if (!Number.isInteger(child) || child <= 0) return;
      if (args.includes("CLONE_THREAD")) {
        tgid.set(child, proc.pid);
        const early = processes.get(child);
        if (early !== undefined) {
          processes.delete(child);
          for (const [read, time] of early.reads)
            if (!proc.reads.has(read)) proc.reads.set(read, time);
          for (const [dir, time] of early.listed)
            if (!proc.listed.has(dir)) proc.listed.set(dir, time);
          proc.execs.push(...early.execs);
        }
        return;
      }
      const existing = processes.get(child);
      const entry: TracedProcess = existing ?? {
        pid: child,
        parent: proc.pid,
        startedAt: at,
        reads: new Map(),
        listed: new Map(),
        execs: [],
      };
      entry.parent = proc.pid;
      entry.startedAt = Math.min(entry.startedAt, at);
      processes.set(child, entry);
      const parentCwd = cwd.get(proc.pid);
      if (parentCwd !== undefined && !cwd.has(child)) cwd.set(child, parentCwd);
      return;
    }
    if (call === "getdents64") {
      const fd = FD.exec(args);
      if (fd?.[1] !== undefined && !proc.listed.has(fd[1])) proc.listed.set(fd[1], at);
      return;
    }
    if (call === "chdir" || call === "fchdir") {
      if (result !== "0") return;
      const target = call === "chdir" ? FIRST_STRING.exec(args)?.[1] : FD.exec(args)?.[1];
      if (target !== undefined) cwd.set(proc.pid, resolve(tid, undefined, unescape(target)));
      return;
    }
    if (WRITE_ONLY.has(call)) return;
    let file: string | undefined;
    let dir: string | undefined;
    const withDir = DIRFD_PATH.exec(args);
    if (
      withDir !== null &&
      (call.endsWith("at") ||
        call === "openat2" ||
        call === "statx" ||
        call === "faccessat2" ||
        call === "newfstatat")
    ) {
      dir = withDir[1];
      file = withDir[2];
    } else {
      file = FIRST_STRING.exec(args)?.[1];
    }
    if (file === undefined) return;
    if ((call === "open" || call === "openat" || call === "openat2") && isWriteOnlyOpen(args))
      return;
    const absolute = resolve(tid, dir, unescape(file));
    if (!proc.reads.has(absolute)) proc.reads.set(absolute, at);
    if (call === "execve" || call === "execveat") proc.execs.push(absolute);
  };

  const stream = NodeFS.createReadStream(path, { encoding: "utf8" });
  const lines = NodeReadline.createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    const match = LINE.exec(line);
    if (match === null) continue;
    const tid = Number(match[1]);
    const at = Number(match[2]);
    const body = match[3] ?? "";
    const resumed = RESUMED.exec(body);
    if (resumed !== null) {
      const start = pending.get(tid);
      pending.delete(tid);
      const call = resumed[1] ?? "";
      const rest = resumed[2] ?? "";
      const result = RESULT.exec(rest)?.[1] ?? null;
      handle(tid, start?.at ?? at, call, `${start?.args ?? ""}${rest}`, result);
      continue;
    }
    const call = CALL.exec(body);
    if (call === null) continue;
    const name = call[1] ?? "";
    const args = call[2] ?? "";
    if (args.endsWith("<unfinished ...>")) {
      const prior = pending.get(tid);
      if (prior !== undefined) handle(tid, prior.at, prior.call, prior.args, null);
      pending.set(tid, { call: name, args, at });
      continue;
    }
    handle(tid, at, name, args, RESULT.exec(args)?.[1] ?? null);
  }
  for (const [tid, start] of pending) handle(tid, start.at, start.call, start.args, null);
  return { processes, root };
}

function isWriteOnlyOpen(args: string): boolean {
  if (args.includes("O_RDWR")) return false;
  return args.includes("O_WRONLY") || args.includes("O_CREAT");
}
