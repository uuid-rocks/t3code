// Stub selectors implementing the bench selector CLI (bench/README.md): `all` selects every unit,
// `none` selects nothing. `record` keeps no state.
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

const [mode, command, ...rest] = process.argv.slice(2);
const { values } = NodeUtil.parseArgs({
  args: rest,
  options: {
    repo: { type: "string" },
    base: { type: "string" },
    store: { type: "string" },
    out: { type: "string" },
  },
});

if (mode !== "all" && mode !== "none")
  throw new Error(`stub mode must be all or none, got ${mode}`);
if (command === "record") {
  process.exit(0);
}
if (command !== "select" || values.out === undefined) {
  throw new Error(
    "usage: stub.ts <all|none> record|select --repo DIR --base SHA --store DIR [--out FILE]",
  );
}
const selection =
  mode === "all" ? { all: true, selected: [], reasons: {} } : { selected: [], reasons: {} };
NodeFS.writeFileSync(values.out, JSON.stringify(selection));
