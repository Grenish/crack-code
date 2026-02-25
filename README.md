# Crack Code

```
_________                       __     _________            .___      
\_   ___ \____________    ____ |  | __ \_   ___ \  ____   __| _/____  
/    \  \/\_  __ \__  \ _/ ___\|  |/ / /    \  \/ /  _ \ / __ |/ __ \ 
\     \____|  | \// __ \\  \___|    <  \     \___(  <_> ) /_/ \  ___/ 
 \______  /|__|  (____  /\___  >__|_ \  \______  /\____/\____ |\___  >
        \/            \/     \/     \/         \/            \/    \/ 
```

**Crack Code** is a cross-platform CLI security analysis tool that uses AI to audit a local codebase and identify vulnerabilities, insecure patterns, architectural weaknesses, secrets exposure, injection risks, dependency issues, and logic flaws. The system is strictly non-destructive: it never edits source files. Instead, it produces structured findings, remediation guidance, and ready-to-use AI prompts that developers can apply manually.

It never edits your code. You stay in control.


## Built-in Tools

Crack Code includes a default agent toolset:

* `browse_dir` – list directory contents
* `find_file_or_folder` – locate files or folders
* `browse_file` – read file contents
* `search_online` – optional web lookup
* `call_mcp` – invoke configured MCP servers

Custom tools can be added with explicit permission and validation.

---

## Supported AI Providers

Crack Code is provider-agnostic and supports:

* OpenAI
* Anthropic (Claude)
* Google Gemini
* Cohere
* xAI (Grok)
* Alibaba (Qwen)
* Moonshot AI (Kimi)
* Ollama (local models)

Models are detected dynamically and tool-capable variants are prioritized.
