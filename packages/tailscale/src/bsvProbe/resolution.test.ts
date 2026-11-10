import { expect, it } from "@effect/vitest";
import { source as fileSource } from "./res/foo";
import { source as dirSource } from "./res/dir";

it("resolves the extensionless import to foo.ts", () => {
  expect(fileSource).toBe("foo.ts");
});

it("resolves the directory import to dir/index.ts", () => {
  expect(dirSource).toBe("dir/index.ts");
});
