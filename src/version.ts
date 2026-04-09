import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type PackageJson = {
  version?: string;
};

const pkg = require("../package.json") as PackageJson;

export const APP_VERSION = pkg.version ?? "0.0.0";
