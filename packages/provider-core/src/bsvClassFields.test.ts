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

it("private class fields are emitted untransformed", () => {
  const source = String(() => {
    class Counter {
      #count = 0;
      next() {
        return ++this.#count;
      }
    }
    return Counter;
  });
  expect(source).toContain("#count");
});
