// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Global Constants
// ─────────────────────────────────────────────────────────────────────────────

import { homedir } from "node:os";
import { join } from "node:path";

// ── Application Identity ────────────────────────────────────────────────────

export const APP_NAME = "Crack Code";
export const APP_BIN = "crack-code";
export const APP_VERSION = "0.1.0";
export const APP_DESCRIPTION =
  "AI-powered CLI security analysis tool — scan, detect, remediate.";

// ── Configuration Paths ─────────────────────────────────────────────────────

/** Root directory for all crack-code configuration and data */
export const CONFIG_DIR = join(homedir(), ".crack-code");

/** Main configuration file (persisted wizard results) */
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

/** Audit log for tool executions and custom tool activity */
export const AUDIT_LOG_FILE = join(CONFIG_DIR, "audit.log");

/** Session history for REPL conversation */
export const HISTORY_FILE = join(CONFIG_DIR, "history.json");

/** MCP server definitions */
export const MCP_CONFIG_FILE = join(CONFIG_DIR, "mcp.json");

/** Custom user-defined tools directory */
export const CUSTOM_TOOLS_DIR = join(CONFIG_DIR, "tools");

// ── Severity Levels ─────────────────────────────────────────────────────────

export const SEVERITY = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  INFO: "info",
} as const;

export type Severity = (typeof SEVERITY)[keyof typeof SEVERITY];

/** Ordered severity levels from most to least severe */
export const SEVERITY_ORDER: readonly Severity[] = [
  SEVERITY.CRITICAL,
  SEVERITY.HIGH,
  SEVERITY.MEDIUM,
  SEVERITY.LOW,
  SEVERITY.INFO,
] as const;

/** Human-readable severity labels */
export const SEVERITY_LABELS: Record<Severity, string> = {
  [SEVERITY.CRITICAL]: "CRITICAL",
  [SEVERITY.HIGH]: "HIGH",
  [SEVERITY.MEDIUM]: "MEDIUM",
  [SEVERITY.LOW]: "LOW",
  [SEVERITY.INFO]: "INFO",
};

// ── Vulnerability Categories ────────────────────────────────────────────────

export const VULN_CATEGORY = {
  INJECTION: "injection",
  XSS: "cross-site-scripting",
  SECRETS_EXPOSURE: "secrets-exposure",
  INSECURE_PATTERN: "insecure-pattern",
  DEPENDENCY_ISSUE: "dependency-issue",
  AUTH_FLAW: "authentication-flaw",
  CRYPTO_WEAKNESS: "cryptographic-weakness",
  LOGIC_FLAW: "logic-flaw",
  PATH_TRAVERSAL: "path-traversal",
  SSRF: "server-side-request-forgery",
  DESERIALIZATION: "insecure-deserialization",
  RACE_CONDITION: "race-condition",
  PRIVILEGE_ESCALATION: "privilege-escalation",
  INFORMATION_DISCLOSURE: "information-disclosure",
  ARCHITECTURAL_WEAKNESS: "architectural-weakness",
  CONFIGURATION_ISSUE: "configuration-issue",
  MISCELLANEOUS: "miscellaneous",
} as const;

export type VulnCategory = (typeof VULN_CATEGORY)[keyof typeof VULN_CATEGORY];

// ── AI Provider Identifiers ─────────────────────────────────────────────────

export const AI_PROVIDER = {
  ANTHROPIC: "anthropic",
  OPENAI: "openai",
  GEMINI: "gemini",
  VERTEX_AI: "vertex_ai",
  COHERE: "cohere",
  XAI: "xai",
  QWEN: "qwen",
  MOONSHOT: "moonshot",
  OLLAMA: "ollama",
} as const;

export type AIProvider = (typeof AI_PROVIDER)[keyof typeof AI_PROVIDER];

/** Human-readable provider names */
export const AI_PROVIDER_LABELS: Record<AIProvider, string> = {
  [AI_PROVIDER.ANTHROPIC]: "Anthropic Claude",
  [AI_PROVIDER.OPENAI]: "OpenAI ChatGPT",
  [AI_PROVIDER.GEMINI]: "Google Gemini",
  [AI_PROVIDER.VERTEX_AI]: "Google Vertex AI",
  [AI_PROVIDER.COHERE]: "Cohere Command",
  [AI_PROVIDER.XAI]: "xAI Grok",
  [AI_PROVIDER.QWEN]: "Alibaba Qwen",
  [AI_PROVIDER.MOONSHOT]: "Moonshot Kimi",
  [AI_PROVIDER.OLLAMA]: "Ollama (Local)",
};

/** Default API base URLs for each provider */
export const AI_PROVIDER_BASE_URLS: Record<AIProvider, string> = {
  [AI_PROVIDER.ANTHROPIC]: "https://api.anthropic.com",
  [AI_PROVIDER.OPENAI]: "https://api.openai.com",
  [AI_PROVIDER.GEMINI]: "https://generativelanguage.googleapis.com",
  [AI_PROVIDER.VERTEX_AI]: "https://us-central1-aiplatform.googleapis.com",
  [AI_PROVIDER.COHERE]: "https://api.cohere.com",
  [AI_PROVIDER.XAI]: "https://api.x.ai",
  [AI_PROVIDER.QWEN]: "https://dashscope.aliyuncs.com",
  [AI_PROVIDER.MOONSHOT]: "https://api.moonshot.cn",
  [AI_PROVIDER.OLLAMA]: "http://localhost:11434",
};

/** Environment variable names for API keys per provider */
export const AI_PROVIDER_ENV_KEYS: Record<AIProvider, string> = {
  [AI_PROVIDER.ANTHROPIC]: "ANTHROPIC_API_KEY",
  [AI_PROVIDER.OPENAI]: "OPENAI_API_KEY",
  [AI_PROVIDER.GEMINI]: "GEMINI_API_KEY",
  [AI_PROVIDER.VERTEX_AI]: "VERTEX_AI_ACCESS_TOKEN",
  [AI_PROVIDER.COHERE]: "COHERE_API_KEY",
  [AI_PROVIDER.XAI]: "XAI_API_KEY",
  [AI_PROVIDER.QWEN]: "DASHSCOPE_API_KEY",
  [AI_PROVIDER.MOONSHOT]: "MOONSHOT_API_KEY",
  [AI_PROVIDER.OLLAMA]: "OLLAMA_HOST",
};

// ── Model Discovery API Endpoints per Provider ─────────────────────────────
// Instead of hardcoding model names, we fetch them from each provider's API
// at runtime and filter for tool-calling capability. Each entry describes
// how to list models, how to extract the model id, and how to detect
// tool-calling support from the API response.

/** Describes how to discover models from a provider's API */
export interface ModelDiscoveryConfig {
  /** HTTP method (GET or POST) */
  method: "GET" | "POST";
  /**
   * URL path appended to the provider's base URL.
   * Use `{{API_KEY}}` as a placeholder when the key must appear in the URL
   * (e.g. Gemini's query-parameter based auth).
   */
  path: string;
  /**
   * How to authenticate the request.
   *  - "bearer"  → Authorization: Bearer <key>
   *  - "x-api-key" → x-api-key: <key>
   *  - "query"   → key is substituted into the URL via `{{API_KEY}}`
   *  - "none"    → no auth header (e.g. Ollama local)
   */
  authStyle: "bearer" | "x-api-key" | "query" | "none";
  /** Additional static headers to include in the request */
  extraHeaders?: Record<string, string>;
  /** Optional POST body (JSON-serializable) */
  body?: unknown;
  /**
   * JSONPath-style dot-notation to the array of model objects in the
   * response JSON. E.g. `"data"` for `{ data: [...] }`,
   * `"models"` for `{ models: [...] }`.
   */
  modelsArrayPath: string;
  /**
   * Dot-notation key within each model object that holds the model id /
   * name string. E.g. `"id"`, `"name"`, `"model"`.
   */
  modelIdKey: string;
  /**
   * Optional dot-notation key within each model object that holds the
   * display-friendly name. Falls back to `modelIdKey` if absent.
   */
  modelDisplayNameKey?: string;
  /**
   * Strategy for detecting tool-calling (function-calling) support:
   *
   *  - `"field"` → check a boolean/array field on each model object.
   *     Requires `toolCallField` to be set.
   *  - `"generation_methods"` → Gemini-style: check if
   *     `supportedGenerationMethods` includes `"generateContent"`.
   *  - `"all"` → assume every returned model supports tool-calling
   *     (provider doesn't expose capability metadata, but the list
   *     endpoint is already scoped to compatible models).
   *  - `"capabilities_field"` → check a nested capabilities object
   *     for a tool-calling flag.
   */
  toolCallDetection:
    | "field"
    | "generation_methods"
    | "all"
    | "capabilities_field";
  /**
   * When `toolCallDetection` is `"field"`, the dot-notation path to the
   * boolean or array field that indicates tool-calling support.
   * E.g. `"capabilities.tool_calling"` or `"supported_features"`.
   */
  toolCallField?: string;
  /**
   * When `toolCallDetection` is `"field"` and the field is an array,
   * the value that must be present in that array to indicate support.
   * E.g. `"tools"` or `"function_calling"`.
   */
  toolCallFieldValue?: string;
  /**
   * When `toolCallDetection` is `"capabilities_field"`, the dot-notation
   * path to the nested capabilities object and the boolean key within it.
   * E.g. `"endpoints.chat.is_tool_use_supported"`.
   */
  capabilitiesPath?: string;
}

export const MODEL_DISCOVERY: Record<AIProvider, ModelDiscoveryConfig> = {
  // ── Anthropic ─────────────────────────────────────────────────────────
  // GET https://api.anthropic.com/v1/models
  // Auth: x-api-key header + anthropic-version header
  // Response: { data: [{ id, display_name, type }] }
  // All returned models support tool use.
  [AI_PROVIDER.ANTHROPIC]: {
    method: "GET",
    path: "/v1/models",
    authStyle: "x-api-key",
    extraHeaders: {
      "anthropic-version": "2023-06-01",
    },
    modelsArrayPath: "data",
    modelIdKey: "id",
    modelDisplayNameKey: "display_name",
    toolCallDetection: "all",
  },

  // ── OpenAI ────────────────────────────────────────────────────────────
  // GET https://api.openai.com/v1/models
  // Auth: Bearer token
  // Response: { data: [{ id, object, owned_by }] }
  // Tool-calling support is not directly exposed in the list response,
  // so we treat all models as potentially capable and let the user pick.
  [AI_PROVIDER.OPENAI]: {
    method: "GET",
    path: "/v1/models",
    authStyle: "bearer",
    modelsArrayPath: "data",
    modelIdKey: "id",
    toolCallDetection: "all",
  },

  // ── Google Gemini ─────────────────────────────────────────────────────
  // GET https://generativelanguage.googleapis.com/v1beta/models?key=<key>
  // Auth: API key as query parameter
  // Response: { models: [{ name, displayName, supportedGenerationMethods }] }
  // Tool-calling: model must include "generateContent" in methods.
  [AI_PROVIDER.GEMINI]: {
    method: "GET",
    path: "/v1beta/models?key={{API_KEY}}",
    authStyle: "query",
    modelsArrayPath: "models",
    modelIdKey: "name",
    modelDisplayNameKey: "displayName",
    toolCallDetection: "generation_methods",
  },

  // ── Google Vertex AI ──────────────────────────────────────────────────
  // GET https://{REGION}-aiplatform.googleapis.com/v1/publishers/google/models
  // Auth: Bearer access token (from gcloud or service account)
  // Response: { models: [{ name, displayName, supportedGenerationMethods }] }
  // The base URL must include the region, e.g. https://us-central1-aiplatform.googleapis.com
  // Project ID and region are set via GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_REGION
  // env vars or encoded in the base URL.
  // Tool-calling: same as Gemini — check supportedGenerationMethods.
  [AI_PROVIDER.VERTEX_AI]: {
    method: "GET",
    // Base URL includes /v1/projects/{project}/locations/{region}
    path: "/publishers/google/models",
    authStyle: "bearer",
    modelsArrayPath: "models",
    modelIdKey: "name",
    modelDisplayNameKey: "displayName",
    toolCallDetection: "all",
  },

  // ── Cohere ────────────────────────────────────────────────────────────
  // GET https://api.cohere.com/v2/models
  // Auth: Bearer token
  // Response: { models: [{ name, endpoints: [{ chat: ... }] }] }
  // Tool-calling: check endpoints.chat.is_tool_use_supported
  [AI_PROVIDER.COHERE]: {
    method: "GET",
    path: "/v2/models",
    authStyle: "bearer",
    modelsArrayPath: "models",
    modelIdKey: "name",
    toolCallDetection: "capabilities_field",
    capabilitiesPath: "endpoints.chat.is_tool_use_supported",
  },

  // ── xAI (Grok) ───────────────────────────────────────────────────────
  // GET https://api.x.ai/v1/models
  // Auth: Bearer token (OpenAI-compatible)
  // Response: { data: [{ id, object, owned_by }] }
  // All listed models support tool calling.
  [AI_PROVIDER.XAI]: {
    method: "GET",
    path: "/v1/models",
    authStyle: "bearer",
    modelsArrayPath: "data",
    modelIdKey: "id",
    toolCallDetection: "all",
  },

  // ── Alibaba Qwen (DashScope) ─────────────────────────────────────────
  // GET https://dashscope.aliyuncs.com/compatible-mode/v1/models
  // Auth: Bearer token (OpenAI-compatible mode)
  // Response: { data: [{ id, object, owned_by }] }
  // All listed chat models support tool calling.
  [AI_PROVIDER.QWEN]: {
    method: "GET",
    path: "/compatible-mode/v1/models",
    authStyle: "bearer",
    modelsArrayPath: "data",
    modelIdKey: "id",
    toolCallDetection: "all",
  },

  // ── Moonshot (Kimi) ───────────────────────────────────────────────────
  // GET https://api.moonshot.cn/v1/models
  // Auth: Bearer token (OpenAI-compatible)
  // Response: { data: [{ id, object, owned_by }] }
  // All listed models support tool calling.
  [AI_PROVIDER.MOONSHOT]: {
    method: "GET",
    path: "/v1/models",
    authStyle: "bearer",
    modelsArrayPath: "data",
    modelIdKey: "id",
    toolCallDetection: "all",
  },

  // ── Ollama (Local) ────────────────────────────────────────────────────
  // GET http://localhost:11434/api/tags
  // Auth: none (local server)
  // Response: { models: [{ name, model, details: { families } }] }
  // Tool-calling: check if details.families array includes "tools".
  // If not exposed, treat all as capable (user chose to install them).
  [AI_PROVIDER.OLLAMA]: {
    method: "GET",
    path: "/api/tags",
    authStyle: "none",
    modelsArrayPath: "models",
    modelIdKey: "model",
    modelDisplayNameKey: "name",
    toolCallDetection: "all",
  },
};

// ── Model Discovery Timeout ─────────────────────────────────────────────────

/** Timeout for model listing API requests in milliseconds (15 seconds) */
export const MODEL_FETCH_TIMEOUT_MS = 15_000;

// ── MCP Provider Identifiers ────────────────────────────────────────────────

export const MCP_PROVIDER = {
  BRAVE: "brave",
  SERPER: "serper",
  TAVILY: "tavily",
  CONTEXT7: "context7",
} as const;

export type MCPProvider = (typeof MCP_PROVIDER)[keyof typeof MCP_PROVIDER];

/** Human-readable MCP provider names */
export const MCP_PROVIDER_LABELS: Record<MCPProvider, string> = {
  [MCP_PROVIDER.BRAVE]: "Brave Search MCP",
  [MCP_PROVIDER.SERPER]: "Serper MCP",
  [MCP_PROVIDER.TAVILY]: "Tavily MCP",
  [MCP_PROVIDER.CONTEXT7]: "Context7 MCP",
};

/** MCP providers that require an API key */
export const MCP_PROVIDERS_REQUIRING_KEY: readonly MCPProvider[] = [
  MCP_PROVIDER.BRAVE,
  MCP_PROVIDER.SERPER,
  MCP_PROVIDER.TAVILY,
];

/** Default preconfigured MCP servers */
export const DEFAULT_MCP_SERVERS: readonly MCPProvider[] = [
  MCP_PROVIDER.CONTEXT7,
];

/** Environment variable names for MCP API keys */
export const MCP_PROVIDER_ENV_KEYS: Record<string, string> = {
  [MCP_PROVIDER.BRAVE]: "BRAVE_API_KEY",
  [MCP_PROVIDER.SERPER]: "SERPER_API_KEY",
  [MCP_PROVIDER.TAVILY]: "TAVILY_API_KEY",
};

// ── Web Search Provider Choices (during wizard) ─────────────────────────────

export const WEB_SEARCH_CHOICES = [
  { value: MCP_PROVIDER.BRAVE, label: "Brave Search MCP" },
  { value: MCP_PROVIDER.SERPER, label: "Serper MCP" },
  { value: MCP_PROVIDER.TAVILY, label: "Tavily MCP" },
  { value: "skip", label: "Skip (no web search)" },
] as const;

// ── File System Scanning Limits ─────────────────────────────────────────────

/** Maximum file size to read (in bytes) — 2 MB */
export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

/** Maximum number of files to scan in a single run */
export const MAX_FILES_PER_SCAN = 10_000;

/** Maximum directory depth for recursive scanning */
export const MAX_SCAN_DEPTH = 30;

/** Maximum number of lines to read from a single file for context */
export const MAX_LINES_PER_FILE = 5_000;

/** Maximum total tokens to send to an AI model per request (approximate) */
export const MAX_CONTEXT_TOKENS = 120_000;

// ── Directories and Files Always Ignored During Scanning ────────────────────

export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".output",
  ".vercel",
  ".netlify",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "venv",
  ".venv",
  "env",
  ".env",
  "vendor",
  ".bundle",
  "target",
  "bin",
  "obj",
  ".idea",
  ".vscode",
  ".DS_Store",
  "coverage",
  ".cache",
  ".turbo",
  ".parcel-cache",
  ".tsbuildinfo",
  ".angular",
  ".sass-cache",
  "tmp",
  "temp",
  "logs",
  ".terraform",
  ".serverless",
]);

export const IGNORED_FILES: ReadonlySet<string> = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  ".gitkeep",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "composer.lock",
  "Gemfile.lock",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
]);

/** Binary and media file extensions to skip */
export const IGNORED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".tiff",
  ".webp",
  ".ico",
  ".svg",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".mkv",
  ".wav",
  ".flac",
  ".ogg",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".jar",
  ".war",
  ".ear",
  ".dll",
  ".exe",
  ".so",
  ".dylib",
  ".o",
  ".a",
  ".lib",
  ".bin",
  ".dat",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".min.js",
  ".min.css",
  ".map",
  ".lock",
  ".lockb",
]);

// ── Scannable Source File Extensions ────────────────────────────────────────

export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".py",
  ".pyw",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".cs",
  ".cpp",
  ".cc",
  ".cxx",
  ".c",
  ".h",
  ".hpp",
  ".hxx",
  ".swift",
  ".m",
  ".mm",
  ".php",
  ".phtml",
  ".lua",
  ".r",
  ".R",
  ".pl",
  ".pm",
  ".ex",
  ".exs",
  ".erl",
  ".hrl",
  ".clj",
  ".cljs",
  ".hs",
  ".dart",
  ".sol",
  ".vy",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".psm1",
  ".bat",
  ".cmd",
]);

/** Configuration and data file extensions worth scanning for secrets/misconfig */
export const CONFIG_EXTENSIONS: ReadonlySet<string> = new Set([
  ".json",
  ".jsonc",
  ".json5",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".env.staging",
  ".properties",
  ".xml",
  ".plist",
  ".tf",
  ".tfvars",
  ".hcl",
  ".dockerfile",
  ".docker-compose.yml",
  ".nginx.conf",
  ".htaccess",
  ".editorconfig",
  ".eslintrc",
  ".prettierrc",
  ".babelrc",
]);

/** Markup and template extensions */
export const MARKUP_EXTENSIONS: ReadonlySet<string> = new Set([
  ".html",
  ".htm",
  ".xhtml",
  ".vue",
  ".svelte",
  ".astro",
  ".ejs",
  ".hbs",
  ".handlebars",
  ".pug",
  ".jade",
  ".erb",
  ".jinja",
  ".jinja2",
  ".twig",
  ".liquid",
  ".njk",
  ".mustache",
  ".md",
  ".mdx",
  ".rst",
  ".tex",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
  ".sql",
  ".graphql",
  ".gql",
  ".proto",
]);

// ── Built-in Tool Names ─────────────────────────────────────────────────────

export const BUILTIN_TOOLS = {
  BROWSE_DIR: "browse_dir",
  BROWSE_FILE: "browse_file",
  FIND_FILE_OR_FOLDER: "find_file_or_folder",
  SEARCH_ONLINE: "search_online",
  CALL_MCP: "call_mcp",
} as const;

export type BuiltinTool = (typeof BUILTIN_TOOLS)[keyof typeof BUILTIN_TOOLS];

// ── TUI Commands ────────────────────────────────────────────────────────────

export const COMMANDS = {
  HELP: "/help",
  CONF: "/conf",
  TOOLS: "/tools",
  MCP: "/mcp",
  HUD: "/hud",
  ICONS: "/icons",
  EXIT: "/exit",
  QUIT: "/quit",
  CLEAR: "/clear",
  SCAN: "/scan",
  REPORT: "/report",
  STATUS: "/status",
} as const;

// ── Agent System Prompt Prefix ──────────────────────────────────────────────

export const SYSTEM_PROMPT_PREFIX = `You are Crack Code, an expert AI security analyst. Your role is to analyze codebases for:
- Vulnerabilities (injection, XSS, SSRF, path traversal, deserialization)
- Secrets exposure (API keys, tokens, passwords, credentials in source)
- Insecure patterns (weak crypto, improper error handling, missing auth)
- Dependency issues (known CVEs, outdated packages, supply chain risks)
- Logic flaws (race conditions, privilege escalation, broken access control)
- Architectural weaknesses (missing input validation layers, insecure defaults)
- Configuration issues (debug mode in production, overly permissive CORS)

IMPORTANT RULES:
1. You MUST NEVER modify, edit, rewrite, or patch any source file directly.
2. You ONLY produce structured findings with severity, classification, explanation, affected files, remediation guidance, and ready-to-use AI prompts.
3. For each finding, generate a specific AI prompt the developer can use to implement the fix.
4. Be thorough but avoid false positives — explain your reasoning.
5. Classify each finding with an appropriate severity level and vulnerability category.
6. When analyzing, consider the full context of the codebase, not just isolated patterns.`;

// ── Timing & Retry Defaults ─────────────────────────────────────────────────

/** Default HTTP request timeout in milliseconds (30 seconds) */
export const HTTP_TIMEOUT_MS = 30_000;

/** Maximum retries for transient API failures */
export const MAX_API_RETRIES = 3;

/** Base delay between retries in milliseconds (exponential backoff) */
export const RETRY_BASE_DELAY_MS = 1_000;

/** Maximum conversation turns before summarization */
export const MAX_CONVERSATION_TURNS = 50;

// ── Exit Codes ──────────────────────────────────────────────────────────────

export const EXIT_CODES = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  CONFIG_ERROR: 2,
  PROVIDER_ERROR: 3,
  SCAN_ERROR: 4,
  INTERRUPTED: 130,
} as const;
