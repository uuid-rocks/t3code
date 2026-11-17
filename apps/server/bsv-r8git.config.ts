import base from "./vite.config.ts";
export default { ...base, test: { ...base.test, name: "bsv-r8git", include: ["src/vcs/GitVcsDriverCore.test.ts", "src/vcs/gitIndexStat.test.ts"] } };
