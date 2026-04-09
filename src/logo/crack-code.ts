import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function CrackCodeLogo() {
  try {
    const logoContent = readFileSync(resolve(__dirname, "./logo.md"), "utf-8");
    return logoContent;
  } catch (error) {
    // Fallback logo if file can't be read
    console.error("Error reading logo file:", error);
    return "crack-code v0.2.1";
  }
}
