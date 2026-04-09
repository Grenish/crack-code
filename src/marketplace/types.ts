export interface ToolManifest {
  id: string;
  name: string;
  description: string;
  schema: Record<string, any>;
}

export interface ToolPackage {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  repository?: string;
  downloads?: number;
  rating?: number;
  tags?: string[];
  main: string;
  tools: ToolManifest[];
  permissions: {
    requiresFileWrite: boolean;
    requiresShellAccess: boolean;
  };
  dependencies?: Record<string, string>;
}

export interface InstalledTool {
  id: string;
  path: string;
  package: ToolPackage;
  installedAt: Date;
  version: string;
}

export interface HubStats {
  installedCount: number;
  availableCount: number;
}

export interface MarketplaceState {
  screen: "hub" | "browse" | "details" | "installed";
  selectedIndex: number;
  selectedPackage?: ToolPackage;
  installedTools: InstalledTool[];
}
