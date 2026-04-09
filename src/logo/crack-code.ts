import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_PATH = resolve(homedir(), ".crack-code", "config.json");
const DEFAULT_LOGO_PATH = resolve(__dirname, "./logo.md");

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function readConfigLogo(): string | null {
  const raw = readTextFile(CONFIG_PATH);
  if (!raw) return null;

  try {
    const config = JSON.parse(raw) as {
      logo?: string;
      useDefaultLogo?: boolean;
    };

    if (config.useDefaultLogo) return null;

    const logo = config.logo?.trim();
    return logo && logo.length > 0 ? logo : null;
  } catch {
    return null;
  }
}

export function CrackCodeLogo(): string {
  const configLogo = readConfigLogo();
  if (configLogo) return configLogo;

  const bundledLogo = readTextFile(DEFAULT_LOGO_PATH);
  if (bundledLogo && bundledLogo.trim().length > 0) {
    return bundledLogo;
  }

  return "crack-code v0.2.1";
}
