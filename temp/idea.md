Design and specify a cross-platform CLI security analysis tool named **Crack Code**. Its purpose is to scan a local codebase using AI to detect vulnerabilities, insecure patterns, architectural weaknesses, secrets exposure, injection risks, dependency issues, and logic flaws. The system must never edit or rewrite source files automatically. It only produces structured findings, remediation guidance, and ready-to-use AI prompts developers can apply manually.

The CLI must be runnable without installation via `npx crack-code@latest` and `bunx crack-code@latest`, and optionally via global installation using `npm i -g crack-code@latest` or `bun add -g crack-code@latest`. After installation, users should be able to run it with `crack-code` or `crack-code .` to scan the current repository.

On first execution, launch an interactive TUI configuration wizard presented step by step. The flow must collect: preferred AI name; AI provider selection (Anthropic Claude, Google Gemini, OpenAI ChatGPT, Cohere Command, xAI Grok, Alibaba Qwen, Moonshot Kimi, Ollama local); API key or endpoint (for Ollama accept server URL such as [http://localhost:11434](http://localhost:11434)); detection of compatible tool-calling models from the provider and selection of a default model; optional web search enablement with MCP providers (Brave MCP, Serper MCP, Tavily MCP, or skip) and API key entry if selected. Configuration should be persisted locally and editable later.

After setup, display a main TUI dashboard showing ASCII branding, tool version, configured host name, current repository path or warning if running in home directory, Git status and active branch if detected, startup tips, and a primary command input. Commands must include `/help`, `/conf`, `/tools`, `/mcp`, `@` for file/folder targeting, and `/hud` to toggle onboarding hints.

Operational behavior centers on AI-assisted static and contextual analysis. The tool must scan directories, parse files, and construct a semantic understanding of the codebase before generating findings. Output format must include severity, vulnerability classification, explanation, affected files, suggested remediation, and an AI prompt developers can use to implement the fix. The system must not apply patches or modify code directly.

Provide a default internal toolset accessible to the AI agent runtime: `browse_dir`, `find_file_or_folder`, `browse_file`, `search_online`, and `call_mcp`. Support user-defined tools under strict rules: explicit permission, sandboxed execution, defined schema, and audit logging. MCP integration must be built in, with at least two default MCP servers preconfigured including Context7, and allow additional MCP configuration later.

The architecture must be provider-agnostic and modular. It should support local models via Ollama and remote APIs interchangeably, allow tool-calling, enable retrieval workflows, and scale across small projects and large monorepos. Emphasis must be placed on extensibility, deterministic scanning workflows, and security-safe execution boundaries.

System architecture diagram:

```
                    ┌────────────────────────────┐
                    │        User Terminal        │
                    │        crack-code CLI       │
                    └─────────────┬──────────────┘
                                  │
                         Interactive TUI Layer
                                  │
                    ┌─────────────┴─────────────┐
                    │   Command + Config Engine  │
                    └─────────────┬─────────────┘
                                  │
                        Agent Orchestration Core
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
  File System Tools        AI Model Gateway           MCP Connector
        │                         │                         │
 browse_dir                 OpenAI API               Brave MCP
 browse_file                Claude API               Tavily MCP
 find_file_or_folder        Gemini API               Serper MCP
        │                   Qwen API                 Context7 MCP
        │                   Grok API                       │
        │                   Cohere API                     │
        │                   Ollama Local                   │
        │                         │                        │
        └──────────────┬──────────┴──────────┬────────────┘
                       │                     │
               Static Analysis Engine   Retrieval + Web Search
                       │                     │
                       └────────────┬────────┘
                                    │
                           Vulnerability Analyzer
                                    │
                         Structured Findings Generator
                                    │
                 Suggestions + Remediation AI Prompts Output
                                    │
                            TUI Result Rendering
```
