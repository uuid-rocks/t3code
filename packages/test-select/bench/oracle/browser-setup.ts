// Copied by the harness into apps/web/.oracle/ for instrumented runs of the browser project. Each
// browser test file gets a window of V8 precise coverage (CDP), written with the served source of
// every script so offsets map through its inline source map.
/// <reference types="vite-plus/test/browser-playwright" />
import { afterAll, beforeEach } from "vite-plus/test";
import { cdp, commands } from "vite-plus/test/browser";

interface ScriptCoverage {
  readonly url: string;
  readonly functions: ReadonlyArray<unknown>;
}

const session = cdp();
let testFile = "";

await session.send("Profiler.enable");
await session.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
await session.send("Profiler.takePreciseCoverage");

beforeEach((context) => {
  testFile = context.task.file.filepath;
});

afterAll(async () => {
  const taken = (await session.send("Profiler.takePreciseCoverage")) as {
    readonly result: ReadonlyArray<ScriptCoverage>;
  };
  const scripts: Array<{ url: string; source: string; functions: ReadonlyArray<unknown> }> = [];
  for (const script of taken.result) {
    if (!script.url.startsWith(location.origin)) continue;
    const path = new URL(script.url).pathname;
    if (
      path.includes("/node_modules/") ||
      path.startsWith("/@vite") ||
      path.startsWith("/@id/") ||
      path.startsWith("/__")
    ) {
      continue;
    }
    const response = await fetch(script.url);
    scripts.push({ url: script.url, source: await response.text(), functions: script.functions });
  }
  const name = `${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  await commands.writeFile(`__ORACLE_OUT__/${name}`, JSON.stringify({ testFile, scripts }));
});
