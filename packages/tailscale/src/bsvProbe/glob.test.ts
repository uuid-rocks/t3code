import { expect, it } from "@effect/vitest";

const modules = import.meta.glob<{ name: string }>("./globFixtures/*.ts", { eager: true });

it("globs exactly the known fixture modules", () => {
  expect(Object.keys(modules)).toEqual(["./globFixtures/a.ts"]);
});
