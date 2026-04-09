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
- 🤖 **Provider-agnostic** — Anthropic, Azure, Google, OpenAI, OpenRouter, Vertex AI, or Ollama with one flag
- 🔒 **Read-only by default** — never modifies files unless you explicitly allow it
- ⚡ **Streaming** — results appear in real-time as the AI analyzes
- 🧰 **Agentic** — reads files, lists directories, runs commands, writes fixes, and maintains shell context
- 🔐 **Permission-gated** — every destructive action requires your approval
- 💬 **Interactive + one-shot** — use as a REPL or a single command
- 🖥️ **Persistent shell** — virtual terminal maintains working directory and environment across commands

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
--provider <name>          Override provider (anthropic, azure, google, openai, openrouter, ollama, vertex)
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
| `/permission` | Choose read-only or edit mode                  |
| `/model`   | Show or change the active model                      |
| `/provider`| Configure a provider and update credentials          |
| `/policy`  | Show or set permission policy                        |
| `/compact` | Summarize conversation to reduce context size        |

Tip: Use `?` prefix for quick asks (e.g., `? what's a security best practice?`)

## Tools

The AI agent has access to these tools during analysis:

| Tool             | Description                                    | Approval |
| ---------------- | ---------------------------------------------- | -------- |
| `read_file`      | Read file contents with line numbers           | No       |
| `list_files`     | List files matching a glob pattern             | No       |
| `virtual_terminal` | Execute shell commands with persistent context | Yes     |
| `run_command`    | Execute isolated shell commands                | Yes      |
| `write_file`     | Write/overwrite files (edit mode)              | Yes      |

### Virtual Terminal Tool

The `virtual_terminal` tool maintains shell context across commands — your working directory and environment variables persist between invocations. Perfect for multi-step workflows:

```bash
# Instead of repeating paths:
run_command "cd src/auth && npm install"
run_command "cd src/auth && npm test"

# Use persistent context:
virtual_terminal "cd src/auth"
virtual_terminal "npm install"
virtual_terminal "npm test"
```

Built-in commands: `cd <path>`, `pwd`, `env`, `env KEY=VALUE`, `unset KEY`, `history`

## Providers

### Anthropic

- **Model**: `claude-opus-4-1`, `claude-3-5-sonnet-20241022`, `claude-3-haiku-20240307`
- **Env var**: `ANTHROPIC_API_KEY`
- **Best for**: Deep reasoning, security analysis, code review

### Azure OpenAI

- **Env vars**: `AZURE_API_KEY`, `AZURE_RESOURCE_NAME`
- **Setup**: Requires Azure resource name (e.g., `myorg-openai`)
- **Best for**: Enterprise deployments, compliance requirements

### Google Gemini

- **Env var**: `GOOGLE_GENERATIVE_AI_API_KEY`
- **Model**: `gemini-2.0-flash`, `gemini-1.5-pro`
- **Best for**: Broad analysis, cost-effective scanning

### OpenAI

- **Env var**: `OPENAI_API_KEY`
- **Model**: `gpt-4-turbo`, `gpt-4o`, `gpt-4o-mini`
- **Best for**: Reliable analysis, well-tested tooling

### OpenRouter

- **Env var**: `OPENROUTER_API_KEY`
- **Support**: Access to 100+ models (Anthropic, OpenAI, Meta, Mistral, etc.)
- **Best for**: Model flexibility, frontier model access

### Vertex AI

- **Auth**: Google Cloud service account JSON
- **Env vars**: `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`
- **Model**: `gemini-2.0-flash`, `gemini-1.5-pro`
- **Best for**: GCP-native deployments, managed infrastructure

### Ollama

- **Env var**: `OLLAMA_ENDPOINT` (default: `http://localhost:11434`)
- **Models**: Any local model supporting tool calling (Llama 2, Mistral, etc.)
- **Best for**: Private scanning, no API costs, full control

## Configuration

Config is stored at `~/.crack-code/config.json` and created automatically on first run.

```bash
# Re-run setup anytime
crack-code --setup

# Change provider and credentials
crack-code /provider
```

### Environment Variables

| Variable                       | Provider   | Purpose                      |
| ------------------------------ | ---------- | ---------------------------- |
| `ANTHROPIC_API_KEY`            | Anthropic  | API authentication           |
| `AZURE_API_KEY`                | Azure      | API key for Azure OpenAI     |
| `AZURE_RESOURCE_NAME`          | Azure      | Azure resource name          |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google     | API key for Gemini           |
| `OPENAI_API_KEY`               | OpenAI     | API key for GPT models       |
| `OPENROUTER_API_KEY`           | OpenRouter | API key for model access     |
| `OLLAMA_ENDPOINT`              | Ollama     | Local endpoint (optional)    |
| `GOOGLE_APPLICATION_CREDENTIALS` | Vertex AI  | Service account JSON path    |
| `GOOGLE_CLOUD_PROJECT`         | Vertex AI  | GCP project ID               |
| `GOOGLE_CLOUD_LOCATION`        | Vertex AI  | Region (default: us-central1)|

If set, the setup wizard will detect and offer to use them.

## Piped Input

```bash
# Pipe code directly for analysis
cat src/db.ts | crack-code

# Pipe with custom prompt
cat src/auth.ts | crack-code "find authentication vulnerabilities"
```

## Examples

### Security Audit

```bash
crack-code "scan src/ for vulnerabilities and explain findings"
```

### Fix Mode

```bash
crack-code --allow-edits "find and fix SQL injections in src/database/"
```

### Targeted Analysis

```bash
crack-code --scan "src/auth/**/*.ts" "check for authentication flaws"
```

### Interactive Mode

```bash
crack-code -i
# Then ask questions like:
# > scan for hardcoded secrets
# > check the auth module for vulnerabilities
# /permission   (choose edit mode)
# /model      (change model)
# /provider   (change provider)
```

## Upcoming Features

- 🛍️ **Tool Marketplace** — discover, install, and publish custom tools for community audits
- 📊 **Enhanced Analytics** — vulnerability heatmaps and trend analysis
- 🔄 **Auto-remediation** — batch apply fixes across codebase
- 📁 **Project Profiles** — save audit configurations per project

## Architecture

- **Runtime**: Bun (fast, all-in-one)
- **AI SDK**: Vercel AI SDK (multi-provider support)
- **Validation**: Zod (type-safe schemas)
- **Terminal**: Custom REPL with streaming markdown support
- **Permissions**: Session-based approval gating

## Troubleshooting

**"No API key found"**
```bash
crack-code --setup          # Run setup wizard
# or set env var and run:
crack-code
```

**Model not available**
```bash
# Try a different model:
crack-code --model "gpt-4-turbo"

# List available models during setup:
crack-code --setup
```

**Permission denied errors**
```bash
# Approve all actions in current session:
crack-code --policy allow-all

# Approve each action individually (default):
crack-code --policy ask
```

## License

[MIT](./LICENSE)
