import { defineConfig } from "vite-plus";
import base from "../../vite.config.ts";
export default defineConfig({ ...base, test: { ...base.test, name: "bsv-sol2-errors" } });
