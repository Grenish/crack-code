<div align="center">

# Crack Code

**AI-powered security auditor for your codebase.**

Scans for vulnerabilities, explains findings with exact code references, and optionally applies fixes — all from your terminal.

[![npm version](https://img.shields.io/npm/v/crack-code)](https://www.npmjs.com/package/crack-code)
[![license](https://img.shields.io/npm/l/crack-code)](./LICENSE)
[![bun](https://img.shields.io/badge/runtime-bun-f472b6)](https://bun.sh)

</div>

---

## Features

- 🛡️ **Security-first** — finds injections, hardcoded secrets, auth flaws, SSRF, XSS, and more
- 🤖 **Provider-agnostic** — Anthropic, OpenAI, Google, or Ollama with one flag
- 🔒 **Read-only by default** — never modifies files unless you explicitly allow it
- ⚡ **Streaming** — results appear in real-time as the AI analyzes
- 🧰 **Agentic** — reads files, lists directories, runs commands, and writes fixes
- 🔐 **Permission-gated** — every destructive action requires your approval
- 💬 **Interactive + one-shot** — use as a REPL or a single command

## Install

```bash
bun install -g crack-code
```

> Requires [Bun](https://bun.sh) v1.0+

## Quick Start

```bash
# First run — setup wizard picks provider, model, and API key
crack-code

# One-shot scan
crack-code "scan this project for vulnerabilities"

# Target specific code
crack-code "check src/auth/ for authentication flaws"

# Interactive REPL
crack-code -i

# Enable file editing
crack-code --allow-edits "fix the SQL injection in src/db.ts"

# Skip permission prompts (use with caution)
crack-code --yolo "scan and fix everything"
```

## CLI Options

```
-i, --interactive          Force interactive REPL mode
--setup                    Re-run the setup wizard
--allow-edits              Enable file writing (read-only by default)
--provider <name>          Override provider (anthropic, openai, google, ollama)
--model <name>             Override model
--key <key>                Override API key
--policy <policy>          Permission policy (ask, skip, allow-all, deny-all)
--scan <glob>              Only scan files matching this pattern
--max-steps <n>            Max agent steps (default: 30)
--max-tokens <n>           Max output tokens per response (default: 16384)
-h, --help                 Show help
-v, --version              Show version
```

## REPL Commands

| Command    | Description                                          |
| ---------- | ---------------------------------------------------- |
| `/help`    | Show available commands                              |
| `/exit`    | Exit the REPL                                        |
| `/clear`   | Clear conversation history                           |
| `/usage`   | Show token usage for this session                    |
| `/mode`    | Toggle read-only ↔ edit mode                         |
| `/model`   | Show current model and provider                      |
| `/policy`  | Show or set permission policy                        |
| `/compact` | Summarize conversation to reduce context size        |

## Tools

The AI agent has access to these tools during analysis:

| Tool          | Description                          | Approval |
| ------------- | ------------------------------------ | -------- |
| `read_file`   | Read file contents with line numbers | No       |
| `list_files`  | List files matching a glob pattern   | No       |
| `run_command` | Execute shell commands               | Yes      |
| `write_file`  | Write/overwrite files (edit mode)    | Yes      |

## Configuration

Config is stored at `~/.crack-code/config.json` and created automatically on first run.

```bash
# Re-run setup anytime
crack-code --setup
```

### Environment Variables

| Variable                       | Provider   |
| ------------------------------ | ---------- |
| `ANTHROPIC_API_KEY`            | Anthropic  |
| `OPENAI_API_KEY`               | OpenAI     |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google     |
| `OLLAMA_ENDPOINT`              | Ollama     |

If set, the setup wizard will detect and offer to use them.

## Piped Input

```bash
# Pipe code directly for analysis
cat src/db.ts | crack-code
```

## License

[MIT](./LICENSE)
