import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "@effect/vitest";

it("queries a committed SQLite fixture", () => {
  const db = new NodeSqlite.DatabaseSync(
    NodePath.join(import.meta.dirname, "fixtures/probe.sqlite"),
    {
      readOnly: true,
    },
  );
  try {
    expect(db.prepare("SELECT v FROM t").get()).toEqual({ v: "ok" });
  } finally {
    db.close();
  }
});
