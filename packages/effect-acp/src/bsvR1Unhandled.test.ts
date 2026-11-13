import { expect, it } from "vitest";

it("passes, then leaves an unhandled rejection", async () => {
  expect(1).toBe(1);
  void Promise.reject(new Error("BSV_R1_UNHANDLED_PROBE"));
  await new Promise((resolve) => setImmediate(resolve));
});
