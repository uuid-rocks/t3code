import { expect, it } from "vitest";

declare const __BSV_XWF_CHANNEL__: string;

it("bsv r3: passes only when the config was built with the release channel", () => {
  expect(__BSV_XWF_CHANNEL__).toBe("release");
});
