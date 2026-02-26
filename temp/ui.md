Fig. 1: Before config
```
_________                       __     _________            .___      
\_   ___ \____________    ____ |  | __ \_   ___ \  ____   __| _/____  
/    \  \/\_  __ \__  \ _/ ___\|  |/ / /    \  \/ /  _ \ / __ |/ __ \ 
\     \____|  | \// __ \\  \___|    <  \     \___(  <_> ) /_/ \  ___/ 
 \______  /|__|  (____  /\___  >__|_ \  \______  /\____/\____ |\___  >
        \/            \/     \/     \/         \/            \/    \/ 
        
Let's start with the config first.
1. What should the AI call you?
   [INPUT BOX PLACEHOLDER: JOHN DOE]
2. Configure your AI agent.
   [1] Anthropic - Claude AI
   [2] Google - Gemini
   [3] OpenAI - ChatGPT
   [4] Cohere - Command
   [5] xAI - Grok
   [6] Alibaba - Qwen
   [7] Moonshot AI - Kimi
   [8] Ollama - Open Source
   You can configure the API key and AI models later as well
3. Enter API Key (For Ollama enter the server url e.g http:/localhost:11434)
   [INPUT BOX PLACEHOLDER - API Key]
4. Select the default model
   These are the models from the API key what suports tool calling and might work with Crack Code.
   [List of compatible models from the API (max 5)]
5. Do you want the web search? [Y/n]
   (if yes)
   You can configure it later as well.
   [1] Brave Search MCP
   [2] Serper MCP
   [3] Tavily MCP
   [4] I changed my mind
   (if selected 1-3)
   Enter the API Key for (Selected provider)
   [INPUT BOX PLACEHOLDER: Web Search API]
   (if no, or 4 just skip)
6. Setting up...
```

Fig. 2: After Config
```
_________                       __     _________            .___      
\_   ___ \____________    ____ |  | __ \_   ___ \  ____   __| _/____  
/    \  \/\_  __ \__  \ _/ ___\|  |/ / /    \  \/ /  _ \ / __ |/ __ \ 
\     \____|  | \// __ \\  \___|    <  \     \___(  <_> ) /_/ \  ___/ 
 \______  /|__|  (____  /\___  >__|_ \  \______  /\____/\____ |\___  >
        \/            \/     \/     \/         \/            \/    \/ 
version: (version number)
 Host: (configuired name)
 Repo: (current directory or  Warning if on home directory)
 Git Enabled : False/True ( branch name)

Hello (name), what are we cracking today?

~(current directory) ( branch name)                            (model name)
-----------------------------------------------------------------------------
> Type @ to mention files, / for commands, or /help for help
-----------------------------------------------------------------------------
```

Fig 2.1: Example for `/` - Given are just the examples from other's TUI CLI
```
_________                       __     _________            .___      
\_   ___ \____________    ____ |  | __ \_   ___ \  ____   __| _/____  
/    \  \/\_  __ \__  \ _/ ___\|  |/ / /    \  \/ /  _ \ / __ |/ __ \ 
\     \____|  | \// __ \\  \___|    <  \     \___(  <_> ) /_/ \  ___/ 
 \______  /|__|  (____  /\___  >__|_ \  \______  /\____/\____ |\___  >
        \/            \/     \/     \/         \/            \/    \/ 
version: (version number)
 Host: (configuired name)
 Repo: (current directory or  Warning if on home directory)
 Git Enabled : False/True ( branch name)

Hello (name), what are we cracking today?

~(current directory) ( branch name)                            (model name)
-----------------------------------------------------------------------------
> /
-----------------------------------------------------------------------------
▋  /add-dir <directory>                         Add a directory to the allowed list for file access
▋  /agent                                       Browse and select from available agents (if any)
▋  /allow-all, /yolo                            Enable all permissions (tools, paths, and URLs)
▋  /changelog [version]                         Display changelog for CLI versions
▋  /clear, /new                                 Clear the conversation history
▋  /compact                                     Summarize conversation history to reduce context window usage
▋  /context                                     Show context window token usage and visualization
▋  /cwd, /cd [directory]                        Change working directory or show current directory
▋  /delegate [prompt]                           Send this session to GitHub and Copilot will create a PR
▋  /diff                                        Review the changes made in the current directory
```

Fig. 2.2: Example for `@`
```
_________                       __     _________            .___      
\_   ___ \____________    ____ |  | __ \_   ___ \  ____   __| _/____  
/    \  \/\_  __ \__  \ _/ ___\|  |/ / /    \  \/ /  _ \ / __ |/ __ \ 
\     \____|  | \// __ \\  \___|    <  \     \___(  <_> ) /_/ \  ___/ 
 \______  /|__|  (____  /\___  >__|_ \  \______  /\____/\____ |\___  >
        \/            \/     \/     \/         \/            \/    \/ 
version: (version number)
 Host: (configuired name)
 Repo: (current directory or  Warning if on home directory)
 Git Enabled : False/True ( branch name)

Hello (name), what are we cracking today?

~(current directory) ( branch name)                            (model name)
-----------------------------------------------------------------------------
> @
-----------------------------------------------------------------------------
▋  @/home/grenishrai/Desktop/apps/crack-code-web
▋  @.gitignore
▋  @.next/
▋  @app/
▋  @app/favicon.ico
▋  @app/globals.css
▋  @app/layout.tsx
▋  @app/page.tsx
▋  @bun.lock
▋  @components.json
```

Fig. 3: User inputs with the process 
```
_________                       __     _________            .___      
\_   ___ \____________    ____ |  | __ \_   ___ \  ____   __| _/____  
/    \  \/\_  __ \__  \ _/ ___\|  |/ / /    \  \/ /  _ \ / __ |/ __ \ 
\     \____|  | \// __ \\  \___|    <  \     \___(  <_> ) /_/ \  ___/ 
 \______  /|__|  (____  /\___  >__|_ \  \______  /\____/\____ |\___  >
        \/            \/     \/     \/         \/            \/    \/ 
version: (version number)
 Host: (configuired name)
 Repo: (current directory or  Warning if on home directory)
 Git Enabled : False/True ( branch name)

Hello (name), what are we cracking today?

❯ analyze the codebase and check for the security concerns

◐ Let me analyze the codebase for security concerns. I'll start by exploring the structure and key files. (Greyed out as this is thinking not the actual state for the thinking models)

● List directory .
  └ 17 files found

● Read package.json for dependencies
  $ cat /home/grenishrai/Desktop/apps/crack-code-web/package.json
  └ 45 lines...

● List directory app
  └ 4 files found

● List directory lib
  └ 1 file found

● Read Next.js config
  $ cat /home/grenishrai/Desktop/apps/crack-code-web/next.config.ts
  └ 8 lines...

● Read app/layout.tsx
  └ 52 lines read

● Read app/page.tsx
  └ 21 lines read

● Read lib/utils.ts
  └ 6 lines read

● List all app and component files
  $ find /home/grenishrai/Desktop/apps/crack-code-web/app -type f | sort && find
  /home/grenishrai/Desktop/apps/crack-code-web/components -type f | sort
  └ 37 lines...

╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ Check for env files and insecure HTTP links                                                                                    │
│                                                                                                                                │
│ ╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮ │
│ │ find /home/grenishrai/Desktop/apps/crack-code-web -maxdepth 2 -name ".env*" 2>/dev/null && grep -r "http://"               │ │
│ │ /home/grenishrai/Desktop/apps/crack-code-web/components /home/grenishrai/Desktop/apps/crack-code-web/app 2>/dev/null |     │ │
│ │ grep -v "node_modules"                                                                                                     │ │
│ ╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯ │
│                                                                                                                                │
│ Do you want to run this command?                                                                                               │
│                                                                                                                                │
│ ❯ 1. Yes                                                                                                                       │
│   2. No, and tell Copilot what to do differently (Esc to stop)                                                                 │
│                                                                                                                                │
│ ↑↓ to navigate · Enter to select · Esc to cancel                                                                               │
╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯

◎ Analyzing codebase security (Esc to cancel · xx.xx KiB/MiB · x token used)


◐ I've now reviewed the entire codebase. Let me summarize the security findings:

  1. Missing `rel="noopener"` in header link - The GitHub link in `site-header.tsx` uses `target="_blank"` with
  `rel="noreferrer"`. Note: `rel="noreferrer"` implicitly includes `noopener`, so this is actually fine in modern browsers.

  2. No Content Security Policy (CSP) - The `next.config.ts` is empty with no security headers configured
  (X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy, CSP, etc.)


  3. Missing viewport meta tag - Not present in layout.tsx, though Next.js may handle this automatically.

  4. Dead links in footer - The docs routes don't exist and would return 404s.

  5. `suppressHydrationWarning` on `<html>` - This is standard with next-themes, not a security concern.

  6. No rate limiting or form protection - Not applicable since this is a static site with no forms or API routes.

  7. Next.js version 16.1.6 - Unusual version numbering, but given the current date, this could be legitimate; I can't flag it
  as a security issue without verification.

  8. Best practice for external links - While `rel="noreferrer"` works, explicitly including both `rel="noopener noreferrer"` is
   the recommended approach.

  9. Unused font imports - The Geist fonts are imported in layout.tsx but their CSS variables aren't being applied anywhere.

  The most significant finding remains the missing HTTP security headers in the configuration.

● Here's a complete security analysis of the codebase:

  -----------------------------------------------------------------------------------------------------------------------------

  Security Analysis — crack-code-web

  This is a static Next.js marketing site with no API routes, forms, or authentication. The attack surface is narrow, but there
  are still meaningful security gaps.

  -----------------------------------------------------------------------------------------------------------------------------

  🔴 High — Missing HTTP Security Headers

  File: next.config.ts

  The config is completely empty. No security headers are set, leaving the app vulnerable to:

   - Clickjacking (no X-Frame-Options / frame-ancestors)
   - MIME sniffing attacks (no X-Content-Type-Options)
   - Info leakage via Referer (no Referrer-Policy)
   - XSS amplification (no Content Security Policy)

  Fix: Add security headers:

   // next.config.ts
   const nextConfig: NextConfig = {
     async headers() {
       return [
         {
           source: "/(.*)",
           headers: [
             { key: "X-Frame-Options", value: "DENY" },
             { key: "X-Content-Type-Options", value: "nosniff" },
             { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
             { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
             { key: "X-DNS-Prefetch-Control", value: "on" },
           ],
         },
       ];
     },
   };

  -----------------------------------------------------------------------------------------------------------------------------

  🟡 Medium — rel="noreferrer" Should Be rel="noopener noreferrer"

  Files: site-header.tsx:45, site-footer.tsx:15, site-footer.tsx:24

  All target="_blank" external links use only rel="noreferrer". While noreferrer implies noopener in modern browsers, the
  explicit combination rel="noopener noreferrer" is the widely accepted best practice for maximum cross-browser safety against
  reverse tabnapping.

  -----------------------------------------------------------------------------------------------------------------------------

  🟡 Medium — Dead Internal Footer Links

  File: site-footer.tsx

   <Link href="/docs" ...>Docs</Link>
   <Link href="/docs/terms" ...>Terms</Link>
   <Link href="/docs/privacy" ...>Privacy</Link>

  These routes (/docs, /docs/terms, /docs/privacy) do not exist in the app. Clicking them results in a 404. A missing Privacy
  Policy page in particular can be a legal/compliance risk (GDPR, CCPA).

  -----------------------------------------------------------------------------------------------------------------------------

  🟢 Low — Unused Font Variables Applied to Body

  File: app/layout.tsx:11-19

  Geist and Geist_Mono fonts are loaded and their CSS variables (--font-geist-sans, --font-geist-mono) are injected, but the
  body only uses font-sans (Inter). These fonts are fetched from Google Fonts unnecessarily, increasing page load and leaking a
  request to an external CDN on every visit. If privacy is a concern, unused fonts should be removed.

  -----------------------------------------------------------------------------------------------------------------------------

  ✅ What's Done Right

  ┌─────────────────────────────────────────────┬──────────────┐
  │ Check                                       │ Status       │
  ├─────────────────────────────────────────────┼──────────────┤
  │ No dangerouslySetInnerHTML                  │ ✅           │
  ├─────────────────────────────────────────────┼──────────────┤
  │ No eval() / document.write()                │ ✅           │
  ├─────────────────────────────────────────────┼──────────────┤
  │ No secrets/credentials in source            │ ✅           │
  ├─────────────────────────────────────────────┼──────────────┤                                                                    │ .env* in .gitignore                         │ ✅           │
  ├─────────────────────────────────────────────┼──────────────┤
  │ No API routes or server actions             │ ✅           │
  ├─────────────────────────────────────────────┼──────────────┤
  │ No localStorage/sessionStorage misuse       │ ✅           │
  ├─────────────────────────────────────────────┼──────────────┤
  │ External links use target="_blank" with rel │ ✅ (partial) │
  ├─────────────────────────────────────────────┼──────────────┤
  │ bun audit — 0 vulnerabilities               │ ✅           │
  └─────────────────────────────────────────────┴──────────────┘

◎ ANalyzed the codebase security (x token used)

~(current directory) ( branch name)                            (model name)
-----------------------------------------------------------------------------
> Type @ to mention files, / for commands, or /help for help
-----------------------------------------------------------------------------
```


Fig. 4: When quit `ctrl + c` two times, it should show the summar similar to this, but in crack-code way:

```
> /quit

╭────────────────────────────────────────────────────────────────────────────────────────────────╮
│                                                                                                │
│  Agent powering down. Goodbye!                                                                 │
│                                                                                                │
│  Interaction Summary                                                                           │
│  Session ID:                 4a58c028-7e9d-4b28-bfc4-a1bd25e75bcd                              │
│  Tool Calls:                 0 ( ✓ 0 x 0 )                                                     │
│  Success Rate:               0.0%                                                              │
│                                                                                                │
│  Performance                                                                                   │
│  Wall Time:                  1h 7m 33s                                                         │
│  Agent Active:               0s                                                                │
│    » API Time:               0s (0.0%)                                                         │
│    » Tool Time:              0s (0.0%)                                                         │
│                                                                                                │
│                                                                                                │
╰────────────────────────────────────────────────────────────────────────────────────────────────╯
```
