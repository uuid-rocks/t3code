import * as NodePath from "node:path";

import { defineConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

const root = NodePath.resolve(import.meta.dirname, "../..");

export default defineConfig({
  ...baseConfig,
  root,
  test: {
    ...baseConfig.test,
    projects: [
      NodePath.join(root, "apps/server/vite.config.ts"),
      {
        extends: true,
        test: {
          name: "root",
          include: ["packages/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
          exclude: [
            ...(baseConfig.test?.exclude ?? []),
            "packages/client-runtime/**",
            "packages/shared/**",
            "packages/contracts/**",
          ],
        },
      },
    ],
  },
});
