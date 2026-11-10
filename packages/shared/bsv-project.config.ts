import { defineConfig } from "vite-plus";
import base from "../../vite.config.ts";
export default defineConfig({ ...base, test: { ...base.test, projects: [
  { extends: true, test: { name: "p", include: ["src/bsv-project-p.test.ts"] } },
  { extends: true, test: { name: "q", include: ["src/bsv-project-q.test.ts"] } },
] } });
