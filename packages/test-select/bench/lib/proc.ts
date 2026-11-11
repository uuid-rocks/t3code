import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

export interface Result {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function run(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly input?: string } = {
    cwd: process.cwd(),
  },
): Result {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    input: options.input,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function check(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly input?: string },
): string {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} (cwd ${options.cwd}) exited ${result.status ?? result.signal}: ${result.stderr.slice(-4000)}`,
    );
  }
  return result.stdout;
}

const active = new Set<NodeChildProcess.ChildProcess>();

/** Sends SIGTERM to every running `runLogged` child, e.g. when the harness is interrupted. */
export function terminateChildren(): void {
  for (const child of active) child.kill("SIGTERM");
}

/** Runs a command with stdout and stderr appended to `logPath`, without buffering output in memory. */
export function runLogged(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly logPath: string },
): Promise<{ readonly status: number | null; readonly signal: string | null }> {
  const fd = NodeFS.openSync(options.logPath, "a");
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", fd, fd],
    });
    active.add(child);
    child.on("error", (error) => {
      active.delete(child);
      NodeFS.closeSync(fd);
      reject(error);
    });
    child.on("exit", (status, signal) => {
      active.delete(child);
      NodeFS.closeSync(fd);
      resolve({ status, signal });
    });
  });
}
