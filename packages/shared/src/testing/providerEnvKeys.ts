export const PROVIDER_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "CODEX_", "OPENAI_", "T3CODE_"];

export const KEPT_ENV = new Set([
  // CI sets these so the transfer budget integration test writes its report for the job summary.
  "T3CODE_TRANSFER_BUDGET_REPORT_PATH",
  "T3CODE_TRANSFER_BUDGET_RESULT_PATH",
  // Opt-in: points the HtmlRender tests at a headless browser, which they skip without.
  "T3CODE_TEST_HEADLESS_SHELL",
]);

