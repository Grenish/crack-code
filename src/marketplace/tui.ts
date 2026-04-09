import * as p from "@clack/prompts";
import type { ToolPackage, InstalledTool } from "./types.js";

export async function launchMarketplaceHub(
  availablePackages: ToolPackage[] = [],
  installedTools: InstalledTool[] = [],
): Promise<void> {
  let exitMarketplace = false;

  while (!exitMarketplace) {
    const choice = await p.select({
      message: "Crack Code Marketplace",
      options: [
        { value: "browse", label: "📦 Browse Community Tools" },
        { value: "installed", label: "✓ View Installed Tools" },
        { value: "exit", label: "↩ Exit Marketplace" },
      ],
    });

    if (p.isCancel(choice)) {
      exitMarketplace = true;
      break;
    }

    if (choice === "browse") {
      await browseCommunityTools(availablePackages);
    } else if (choice === "installed") {
      await viewInstalledTools(installedTools);
    } else if (choice === "exit") {
      exitMarketplace = true;
    }
  }
}

async function browseCommunityTools(packages: ToolPackage[]): Promise<void> {
  if (packages.length === 0) {
    p.note("No tools available in the marketplace yet.", "Browse Tools");
    return;
  }

  const choice = await p.select({
    message: "Available Tools",
    options: packages.map((pkg) => ({
      value: pkg.id,
      label: `${pkg.name} (${pkg.version})`,
      hint: pkg.description?.substring(0, 50),
    })),
  });

  if (p.isCancel(choice)) {
    return;
  }

  const selectedPackage = packages.find((pkg) => pkg.id === choice);
  if (selectedPackage) {
    await viewToolDetails(selectedPackage);
  }
}

async function viewToolDetails(pkg: ToolPackage): Promise<void> {
  p.note(
    `${pkg.name} v${pkg.version}\n` +
      `Author: ${pkg.author}\n` +
      `License: ${pkg.license}\n\n` +
      `${pkg.description}\n\n` +
      `Tools: ${pkg.tools.map((t) => t.name).join(", ")}`,
    pkg.name,
  );
}

async function viewInstalledTools(tools: InstalledTool[]): Promise<void> {
  if (tools.length === 0) {
    p.note(
      "No tools installed yet. Browse the marketplace to install tools.",
      "Installed Tools",
    );
    return;
  }

  const toolList = tools
    .map((t) => `✓ ${t.package.name} (${t.version})`)
    .join("\n");

  p.note(toolList, `Installed Tools (${tools.length})`);
}
