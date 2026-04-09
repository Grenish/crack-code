# Marketplace Implementation Plan

## Overview

The Crack Code Marketplace is a community-driven platform for sharing, discovering, and installing custom tools. This plan outlines the phased approach to building a vibrant ecosystem of security-focused tools beyond the built-in offerings.

## Phase 1: MVP (Initial Implementation)

### Goals
- Create `/marketplace` slash command that launches an interactive hub
- Browse available community tools
- View tool details and documentation
- Install tools locally from mock registry
- Manage installed tools

### Core Components

#### 1. Marketplace Module (`src/marketplace/`)
- **types.ts** — Data structures for tools, packages, manifests
- **store.ts** — Local tool installation/uninstallation logic
- **registry.ts** — Mock registry implementation (Phase 1)
- **tui.ts** — Interactive TUI screens (hub, browse, details, install, manage)
- **loader.ts** — Load and validate tool packages

#### 2. Tool Package Manifest

Tools will be packaged with a `tool.json` manifest:

```json
{
  "name": "tool-name",
  "version": "1.0.0",
  "description": "Tool description",
  "author": "Author Name",
  "license": "MIT",
  "main": "./dist/index.ts",
  "tools": [
    {
      "id": "unique_tool_id",
      "name": "Display Name",
      "description": "What this tool does",
      "schema": {
        // Zod schema for tool parameters
      }
    }
  ],
  "dependencies": {
    // npm dependencies if any
  },
  "permissions": {
    "requiresFileWrite": false,
    "requiresShellAccess": false
  }
}
```

#### 3. Local Tool Storage

Installed tools stored in: `~/.crack-code/tools/`

Structure:
```
~/.crack-code/tools/
  ├── tool-1/
  │   ├── package.json
  │   ├── tool.json
  │   ├── dist/
  │   └── ...
  └── tool-2/
      └── ...
```

#### 4. TUI Screens

**Hub Screen**
- Welcome message
- Quick stats (installed tools, available tools)
- Menu: Browse, Installed, Search, Exit

**Browse Screen**
- List of available tools
- Show name, version, rating/installs
- Navigate with arrow keys, select to view details

**Details Screen**
- Full tool information
- Description, author, license
- Required permissions
- Install/Update/Remove buttons
- Option to view documentation

**Installed Tools Screen**
- List of locally installed tools
- Version, last updated
- Quick access to uninstall or update

**Install Confirmation Screen**
- Tool name and version
- Permission summary
- Confirm/Cancel

### `/marketplace` Slash Command

Handler in `repl.ts`:
```
/marketplace   Open the community tool marketplace
```

Launches the TUI hub when invoked during interactive session.

## Phase 2: Registry Integration

### Goals
- Replace mock registry with real source
- Support npm scoped packages (`@crack-code/*`)
- OR custom API registry

### Options
1. **npm scope** — Publish tools as `@crack-code/tool-name`
2. **Custom API** — Dedicated registry service
3. **Hybrid** — Custom API with npm fallback

## Phase 3: Tool Verification & Security

- Tool signing and verification
- Dependency scanning
- Malware detection
- Curated vs community trust levels

## Phase 4: Publishing Workflow

### CLI Commands
```
crack-code publish [dir]        Publish a tool to marketplace
crack-code install <tool>       Install a tool
crack-code uninstall <tool>     Remove a tool
crack-code list-tools           Show installed tools
```

### Publishing Flow
1. Validate tool structure and manifest
2. Run security checks
3. Prompt for registry credentials
4. Upload to registry
5. Generate shareable link

## Data Structures

### ToolPackage
```typescript
interface ToolPackage {
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
  permissions: {
    requiresFileWrite: boolean;
    requiresShellAccess: boolean;
  };
  tools: Array<{
    id: string;
    name: string;
    description: string;
  }>;
}
```

### InstalledTool
```typescript
interface InstalledTool {
  id: string;
  path: string;
  package: ToolPackage;
  installedAt: Date;
  version: string;
}
```

## Implementation Notes

- All TUI interactions use existing `@clack/prompts` infrastructure
- Tool loading is lazy — only loaded when user interacts with them
- Installed tools are dynamically registered with ToolRegistry on startup
- Installation is sandboxed to `~/.crack-code/tools/` for security
- Validation and permission checks happen at install time and runtime

## Future Enhancements

- Web UI for marketplace browsing
- Ratings and reviews
- Tool versioning and compatibility checks
- Automated tool updates
- Tool templates and scaffolding
- API for programmatic access
- Analytics and usage tracking