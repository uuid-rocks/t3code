import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import blacksmith from "@useblacksmith/vitest";

export default defineConfig({
  plugins: [blacksmith({ cacheKey: "r07-srv-w4" })],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: [
      "../shared/src/testing/longTempDir.ts",
      "../shared/src/testing/providerEnv.ts",
      "../shared/src/testing/gitEnv.ts",
    ],
  },
});
