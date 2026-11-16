import { expect, it } from "vitest";

class Base {
  constructor() {
    this.init();
  }
  init() {}
}

class Child extends Base {
  value!: number;
  override init() {
    this.value = 1;
  }
}

it("redeclared class fields follow [[Define]] semantics", () => {
  expect(new Child().value).toBe(undefined);
});
