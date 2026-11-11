// Copied by the harness into the checkout under test (apps/web/.oracle/) and passed as `--config`
// for instrumented runs: the web config with the oracle's coverage setup added to the browser
// project and file parallelism off, so each browser file has its own coverage window.
import * as NodePath from "node:path";

import { type ConfigEnv, loadConfigFromFile, type UserConfig } from "vite-plus";

const root = NodePath.resolve(import.meta.dirname, "..");

export default async (env: ConfigEnv): Promise<UserConfig> => {
  const loaded = await loadConfigFromFile(env, NodePath.join(root, "vite.config.ts"), root);
  if (loaded === null) throw new Error("apps/web/vite.config.ts did not load");
  const config = loaded.config;
  const projects = config.test?.projects ?? [];
  let found = false;
  for (const project of projects) {
    if (typeof project !== "object" || project === null || !("test" in project)) continue;
    const test = project.test;
    if (test?.name !== "browser") continue;
    const setupFiles = test.setupFiles ?? [];
    test.setupFiles = [
      ...(Array.isArray(setupFiles) ? setupFiles : [setupFiles]),
      "./.oracle/browser-setup.ts",
    ];
    test.fileParallelism = false;
    found = true;
  }
  if (!found) throw new Error("apps/web/vite.config.ts has no project named browser");
  return { ...config, root };
};
