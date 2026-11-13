import { defineConfig } from "vite-plus";
import base from "../../vite.config.ts";
// Like apps/server/vite.config.ts's telemetry channel: a define built from the workflow's env.
const channel = process.env.BSV_XWF_CHANNEL?.trim() || "dev";
export default defineConfig({
  ...base,
  define: { ...base.define, __BSV_XWF_CHANNEL__: JSON.stringify(channel) },
  test: { ...base.test, name: "bsv-r3-core" },
});
