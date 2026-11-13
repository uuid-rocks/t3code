import { defineConfig } from "vite-plus";
import base from "../../vite.config.ts";
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    name: "bsv-r1-acp-cov",
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary"],
      thresholds: { lines: 100 },
    },
  },
});
