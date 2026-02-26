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
* Google Gemini (AI Studio)
* Google Vertex AI (GCP)
* Cohere
* xAI (Grok)
* Alibaba (Qwen)
* Moonshot AI (Kimi)
* Ollama (local models)

Models are detected dynamically and tool-capable variants are prioritized.

### Vertex AI Setup

Google Vertex AI serves the same Gemini models but through GCP's enterprise platform with IAM-based auth instead of API keys.

1. **Enable the Vertex AI API** in your GCP project.
2. **Authenticate** — obtain an access token:
   ```
   gcloud auth print-access-token
   ```
3. **Set environment variables** (or configure via `/conf`):
   ```
   export VERTEX_AI_ACCESS_TOKEN="ya29...."
   export GOOGLE_CLOUD_PROJECT="my-project-id"
   export GOOGLE_CLOUD_REGION="us-central1"       # optional, defaults to us-central1
   ```
4. Select **Google Vertex AI** as the provider when running the configuration wizard.

The base URL is derived automatically from the region (e.g. `https://us-central1-aiplatform.googleapis.com`). You can override it in the config if needed.

---

## Terminal Requirements

Crack Code's CLI uses styled icons to render status indicators, bullets, badges, and other UI elements. Three icon rendering modes are available:

| Mode | Description | When to use |
|------|-------------|-------------|
| `nerd` | Nerd Font PUA glyphs (default) | Full-featured terminals with a patched font installed |
| `unicode` | Standard Unicode symbols (✔, ✖, ⚙, →, etc.) | Modern terminals without a Nerd Font |
| `ascii` | Pure ASCII fallbacks (`[ok]`, `[x]`, `[gear]`, `->`) | CI pipelines, piped output, legacy terminals |

### Setting the icon mode

The icon mode is controlled by the `display.iconMode` field in your configuration. You can change it interactively:

```
/conf
```

Or set it directly in `~/.crack-code/config.json`:

```json
{
  "display": {
    "iconMode": "nerd"
  }
}
```

If icons appear as empty boxes (`□`) or question marks, switch to `"unicode"` or `"ascii"`.

### Installing a Nerd Font (recommended)

A **Nerd Font** is a regular programming font patched with thousands of extra glyphs (icons, powerline symbols, devicons, etc.). Crack Code's default `"nerd"` mode requires one.

1. Download a patched font from [nerdfonts.com](https://www.nerdfonts.com/font-downloads).
   Popular choices: **FiraCode Nerd Font**, **Hack Nerd Font**, **JetBrainsMono Nerd Font**.

2. Install the font on your system:
   - **Linux** — copy `.ttf` / `.otf` files to `~/.local/share/fonts/` then run `fc-cache -fv`.
   - **macOS** — double-click each font file and click *Install Font*, or use `brew install --cask font-fira-code-nerd-font`.
   - **Windows** — right-click each font file → *Install for all users*.

3. Configure your terminal emulator to use the installed Nerd Font:

   | Terminal | Setting location |
   |----------|-----------------|
   | **iTerm2** | Preferences → Profiles → Text → Font |
   | **Windows Terminal** | Settings → Profiles → Appearance → Font face |
   | **Alacritty** | `~/.config/alacritty/alacritty.toml` → `[font.normal]` → `family` |
   | **Kitty** | `~/.config/kitty/kitty.conf` → `font_family` |
   | **GNOME Terminal** | Preferences → Profile → Custom font |
   | **WezTerm** | `~/.wezterm.lua` → `config.font` |

4. Restart your terminal and run Crack Code — icons should render correctly.

### Color support

Crack Code auto-detects 256-color and truecolor support. You can override color behavior with `display.colorMode`:

- `"auto"` — detect from the terminal (default)
- `"always"` — force colors on (useful when piping to `less -R`)
- `"never"` — disable all ANSI colors
