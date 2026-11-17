import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

import { testSelectionPlugins } from "../../vitest-selection.ts";

export default defineConfig({
  plugins: testSelectionPlugins(),
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["../shared/src/testing/longTempDir.ts", "../shared/src/testing/providerEnv.ts"],
  },
});
