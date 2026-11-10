import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { greet } from "./res/mocked.ts";

vi.mock("./res/mocked.ts");

it("automocks the module when no __mocks__ file exists", () => {
  expect(greet()).toBeUndefined();
});
