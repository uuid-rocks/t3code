import base from "./vite.config.ts";
export default { ...base, test: { ...base.test, name: "bsv-r8grow" } };
