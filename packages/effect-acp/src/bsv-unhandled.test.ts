import { setImmediate } from "node:timers/promises";
import { expect, it } from "vite-plus/test";

const unhandled = false;
it("reports an unhandled error after a passing assertion", async () => {
  expect(true).toBe(true);
  if (unhandled) {
    void Promise.reject(new Error("BSV_UNHANDLED_PROBE"));
    await setImmediate();
  }
});
