// @effect-diagnostics nodeBuiltinImport:off - Vitest loads this from config, outside any Effect runtime.
import blacksmithExport from "@useblacksmith/vitest";
import type { Plugin } from "vite-plus";

// apps/mobile is a CommonJS package: Vite bundles its config to CJS, and the
// interop wraps this ESM-only package's namespace once more.
const blacksmith: typeof blacksmithExport =
  typeof blacksmithExport === "function"
    ? blacksmithExport
    : (blacksmithExport as unknown as { default: typeof blacksmithExport }).default;

// bsv r07 issues: BSV_ARM is set by this branch, not by CI. "on" loads the plugin.
const BSV_ARM: string = "off";

export function testSelectionPlugins(): Plugin[] {
  return BSV_ARM === "on" ? [blacksmith({ cacheKey: "r07-issues-up" })] : [];
}
