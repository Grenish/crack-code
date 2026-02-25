// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Static Analyzer
// ─────────────────────────────────────────────────────────────────────────────
// Provides three analysis pipelines that run against scanned files:
//
//   1. Pattern Matching  — regex-based rules that detect common vulnerability
//      patterns (SQL injection, XSS, path traversal, insecure crypto, etc.)
//
//   2. Secret Detection  — high-entropy string scanning plus known-format
//      regex patterns for API keys, tokens, passwords, and credentials.
//
//   3. Dependency Audit  — inspects parsed manifests for known risky
//      patterns (pinning, typosquatting heuristics, wildcard versions).
//
// Every pipeline produces Finding objects (from output/findings.ts). The
// analyzer NEVER modifies source files — it only reads and reports.
//
// Zero external dependencies.
// ─────────────────────────────────────────────────────────────────────────────

import {
  SEVERITY,
  SEVERITY_ORDER,
  VULN_CATEGORY,
  type Severity,
  type VulnCategory,
} from "../utils/constants.js";

import {
  createFinding,
  createFindings,
  mergeFindings,
  type Finding,
  type FindingInput,
  type AffectedLocation,
  type FindingSource,
} from "../output/findings.js";

import type {
  ScannedFile,
  ScannedManifest,
  ScanResult,
} from "../scanner/index.js";

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A single pattern-match rule used by the static analyzer.
 */
export interface PatternRule {
  /** Unique rule identifier (e.g. "SQL_INJECTION_CONCAT") */
  id: string;
  /** Human-readable title */
  title: string;
  /** Detailed description of what the rule detects */
  description: string;
  /** Regex pattern to match against file content (per-line) */
  pattern: RegExp;
  /** Severity of findings produced by this rule */
  severity: Severity;
  /** Vulnerability category */
  category: VulnCategory;
  /** Remediation advice */
  remediation: string;
  /** CWE identifiers */
  cweIds: string[];
  /** OWASP Top 10 category */
  owaspCategory?: string;
  /** File extensions this rule applies to (empty = all scannable files) */
  appliesTo: string[];
  /** File extensions this rule should NOT apply to */
  excludeExts: string[];
  /** Confidence level (0.0–1.0) */
  confidence: number;
  /** Reference links */
  references: string[];
  /** Whether this rule is enabled (default true) */
  enabled: boolean;
}

/**
 * A secret detection pattern.
 */
export interface SecretPattern {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Regex to detect the secret */
  pattern: RegExp;
  /** Severity (usually HIGH or CRITICAL) */
  severity: Severity;
  /** Confidence (0.0–1.0) */
  confidence: number;
  /** Description of the secret type */
  description: string;
  /** Remediation advice */
  remediation: string;
  /** CWE IDs */
  cweIds: string[];
  /** File extensions to check (empty = all) */
  appliesTo: string[];
  /** Extensions to skip */
  excludeExts: string[];
}

/**
 * Options to configure analysis behavior.
 */
export interface AnalyzeOptions {
  /** Minimum severity to report (default: "info") */
  minSeverity?: Severity;
  /** Minimum confidence to report (default: 0.3) */
  minConfidence?: number;
  /** Whether to run pattern matching (default: true) */
  enablePatterns?: boolean;
  /** Whether to run secret detection (default: true) */
  enableSecrets?: boolean;
  /** Whether to run dependency audit (default: true) */
  enableDependencies?: boolean;
  /** Additional custom pattern rules */
  customRules?: PatternRule[];
  /** Additional custom secret patterns */
  customSecretPatterns?: SecretPattern[];
  /** Maximum findings per file (to prevent flood) */
  maxFindingsPerFile?: number;
  /** Abort signal */
  signal?: AbortSignal;
  /** Progress callback */
  onProgress?: (analyzed: number, total: number, currentFile: string) => void;
}

/**
 * Result of a full analysis run.
 */
export interface AnalysisResult {
  /** All findings from all pipelines (sorted, deduplicated) */
  findings: Finding[];
  /** Findings from pattern matching only */
  patternFindings: Finding[];
  /** Findings from secret detection only */
  secretFindings: Finding[];
  /** Findings from dependency audit only */
  dependencyFindings: Finding[];
  /** Number of files analyzed */
  filesAnalyzed: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Any warnings generated during analysis */
  warnings: string[];
}

// ═════════════════════════════════════════════════════════════════════════════
// Built-in Pattern Rules
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Default set of vulnerability detection rules.
 *
 * Each rule is a regex that runs line-by-line against file content. When
 * matched, it produces a Finding with the rule's severity and metadata.
 */
export const BUILTIN_PATTERN_RULES: PatternRule[] = [
  // ── SQL Injection ───────────────────────────────────────────────────
  {
    id: "SQL_INJECTION_CONCAT",
    title: "Possible SQL injection via string concatenation",
    description:
      "SQL query constructed using string concatenation with user-controllable input. " +
      "This is one of the most common and dangerous vulnerability patterns.",
    pattern:
      /(?:query|execute|exec|raw|sql)\s*\(\s*['"`].*?\+\s*(?:req\.|params\.|body\.|query\.|args\.|input|user)/i,
    severity: SEVERITY.CRITICAL,
    category: VULN_CATEGORY.INJECTION,
    remediation:
      "Use parameterized queries or prepared statements instead of string concatenation. " +
      "Most ORMs and database drivers support parameter binding (e.g. $1, ?, :param).",
    cweIds: ["CWE-89"],
    owaspCategory: "A03:2021",
    appliesTo: [
      ".ts",
      ".js",
      ".jsx",
      ".tsx",
      ".mjs",
      ".cjs",
      ".py",
      ".rb",
      ".php",
      ".go",
      ".java",
    ],
    excludeExts: [],
    confidence: 0.85,
    references: ["https://owasp.org/Top10/A03_2021-Injection/"],
    enabled: true,
  },
  {
    id: "SQL_INJECTION_TEMPLATE",
    title: "Possible SQL injection via template literal",
    description:
      "SQL query constructed using a template literal with embedded expressions. " +
      "Template literals with user input are just as dangerous as string concatenation.",
    pattern:
      /(?:query|execute|exec|raw|sql)\s*\(\s*`[^`]*\$\{.*?(?:req\.|params\.|body\.|query\.|args\.|input|user)/i,
    severity: SEVERITY.CRITICAL,
    category: VULN_CATEGORY.INJECTION,
    remediation:
      "Use parameterized queries instead of template literals for SQL construction. " +
      "Never interpolate user input directly into SQL strings.",
    cweIds: ["CWE-89"],
    owaspCategory: "A03:2021",
    appliesTo: [".ts", ".js", ".jsx", ".tsx", ".mjs", ".cjs"],
    excludeExts: [],
    confidence: 0.9,
    references: ["https://owasp.org/Top10/A03_2021-Injection/"],
    enabled: true,
  },

  // ── XSS ─────────────────────────────────────────────────────────────
  {
    id: "XSS_INNERHTML",
    title: "Potential XSS via innerHTML assignment",
    description:
      "Direct assignment to innerHTML with dynamic content can lead to Cross-Site Scripting " +
      "if the content is not properly sanitized.",
    pattern: /\.innerHTML\s*=\s*(?!['"`]\s*$)/,
    severity: SEVERITY.HIGH,
    category: VULN_CATEGORY.XSS,
    remediation:
      "Use textContent instead of innerHTML for plain text, or use a sanitization library " +
      "(e.g. DOMPurify) before assigning HTML content. In React, avoid dangerouslySetInnerHTML.",
    cweIds: ["CWE-79"],
    owaspCategory: "A03:2021",
    appliesTo: [
      ".ts",
      ".js",
      ".jsx",
      ".tsx",
      ".mjs",
      ".cjs",
      ".html",
      ".vue",
      ".svelte",
    ],
    excludeExts: [],
    confidence: 0.7,
    references: ["https://owasp.org/Top10/A03_2021-Injection/"],
    enabled: true,
  },
  {
    id: "XSS_DANGEROUS_INNER_HTML",
    title: "React dangerouslySetInnerHTML usage",
    description:
      "Usage of dangerouslySetInnerHTML in React components. If the HTML content " +
      "includes unsanitized user input, this leads to XSS vulnerabilities.",
    pattern: /dangerouslySetInnerHTML/,
    severity: SEVERITY.MEDIUM,
    category: VULN_CATEGORY.XSS,
    remediation:
      "Sanitize HTML content using DOMPurify or a similar library before passing it to " +
      "dangerouslySetInnerHTML. Consider if you truly need raw HTML insertion.",
    cweIds: ["CWE-79"],
    owaspCategory: "A03:2021",
    appliesTo: [".tsx", ".jsx", ".ts", ".js"],
    excludeExts: [],
    confidence: 0.6,
    references: [],
    enabled: true,
  },
  {
    id: "XSS_DOCUMENT_WRITE",
    title: "Potential XSS via document.write",
    description:
      "document.write() with dynamic content can introduce XSS vulnerabilities. " +
      "It also causes performance issues by blocking HTML parsing.",
    pattern: /document\.write\s*\(/,
    severity: SEVERITY.HIGH,
    category: VULN_CATEGORY.XSS,
    remediation:
      "Replace document.write() with safe DOM APIs like createElement, textContent, or " +
      "a templating framework.",
    cweIds: ["CWE-79"],
    owaspCategory: "A03:2021",
    appliesTo: [".ts", ".js", ".jsx", ".tsx", ".html"],
    excludeExts: [],
    confidence: 0.65,
    references: [],
    enabled: true,
  },

  // ── Eval / Code Injection ───────────────────────────────────────────
  {
    id: "CODE_INJECTION_EVAL",
    title: "Use of eval() with dynamic input",
    description:
      "eval() executes arbitrary code and is extremely dangerous when used with any " +
      "form of user-controllable input. Even with trusted input, eval can introduce " +
      "unexpected behavior and makes code harder to audit.",
    pattern: /\beval\s*\(\s*(?!['"`]\s*\))/,
    severity: SEVERITY.CRITICAL,
    category: VULN_CATEGORY.INJECTION,
    remediation:
      "Remove eval() entirely. Use JSON.parse() for JSON data, Function() constructor " +
      "for specific needs (still risky), or restructure code to avoid dynamic evaluation.",
    cweIds: ["CWE-94", "CWE-95"],
    owaspCategory: "A03:2021",
    appliesTo: [
      ".ts",
      ".js",
      ".jsx",
      ".tsx",
      ".mjs",
      ".cjs",
      ".py",
      ".rb",
      ".php",
    ],
    excludeExts: [],
    confidence: 0.75,
    references: [],
    enabled: true,
  },
  {
    id: "CODE_INJECTION_FUNCTION",
    title: "Dynamic code execution via Function constructor",
    description:
      "The Function constructor creates functions from strings, which is equivalent " +
      "to eval() and carries the same injection risks.",
    pattern: /new\s+Function\s*\(\s*(?!['"`]\s*\))/,
    severity: SEVERITY.HIGH,
    category: VULN_CATEGORY.INJECTION,
    remediation:
      "Avoid using the Function constructor with dynamic input. Restructure code " +
      "to use static functions or safe alternatives.",
    cweIds: ["CWE-94"],
    owaspCategory: "A03:2021",
    appliesTo: [".ts", ".js", ".jsx", ".tsx", ".mjs", ".cjs"],
    excludeExts: [],
    confidence: 0.7,
    references: [],
    enabled: true,
  },

  // ── Command Injection ───────────────────────────────────────────────
  {
    id: "CMD_INJECTION_EXEC",
    title: "Potential command injection via child_process",
    description:
      "Using exec/execSync with string arguments allows shell command injection. " +
      "If any part of the command string comes from user input, an attacker can " +
      "execute arbitrary system commands.",
    pattern:
      /(?:child_process|exec|execSync|spawn)\s*\(\s*(?:['"`].*?\+|`[^`]*\$\{)/,
    severity: SEVERITY.CRITICAL,
    category: VULN_CATEGORY.INJECTION,
    remediation:
      "Use execFile or spawn with an argument array instead of exec with string concatenation. " +
      "Never pass unsanitized user input to shell commands.",
    cweIds: ["CWE-78"],
    owaspCategory: "A03:2021",
    appliesTo: [".ts", ".js", ".jsx", ".tsx", ".mjs", ".cjs"],
    excludeExts: [],
    confidence: 0.8,
    references: [],
    enabled: true,
  },
  {
    id: "CMD_INJECTION_SUBPROCESS",
    title: "Potential command injection via subprocess",
    description:
      "Using subprocess/os.system with shell=True or string commands allows " +
      "shell command injection when user input is included.",
    pattern:
      /(?:subprocess\.(?:call|run|Popen)|os\.system|os\.popen)\s*\(\s*(?:f['"]|['"].*?\+|['"].*?%\s*\(|['"].*?\.format\()/,
    severity: SEVERITY.CRITICAL,
    category: VULN_CATEGORY.INJECTION,
    remediation:
      "Use subprocess with a list of arguments instead of shell=True. " +
      "Use shlex.quote() if shell mode is absolutely necessary.",
    cweIds: ["CWE-78"],
    owaspCategory: "A03:2021",
    appliesTo: [".py"],
    excludeExts: [],
    confidence: 0.8,
    references: [],
    enabled: true,
  },

  // ── Path Traversal ──────────────────────────────────────────────────
  {
    id: "PATH_TRAVERSAL_CONCAT",
    title: "Potential path traversal via unsanitized path construction",
    description:
      "File path constructed using user input without validation against directory " +
      "traversal (../) sequences. An attacker could read or write arbitrary files.",
    pattern:
      /(?:readFile|writeFile|createReadStream|createWriteStream|appendFile|access|open)\s*\(\s*(?:.*?\+\s*(?:req\.|params\.|body\.|query\.|args\.|input|user)|`[^`]*\$\{.*?(?:req\.|params\.|body\.|query\.))/i,
    severity: SEVERITY.HIGH,
    category: VULN_CATEGORY.PATH_TRAVERSAL,
    remediation:
      "Validate and sanitize file paths using path.resolve() and ensure the resolved path " +
      "is within an allowed base directory. Reject paths containing '..' sequences.",
    cweIds: ["CWE-22"],
    owaspCategory: "A01:2021",
    appliesTo: [".ts", ".js", ".jsx", ".tsx", ".mjs", ".cjs"],
    excludeExts: [],
    confidence: 0.75,
    references: [],
    enabled: true,
  },

  // ── SSRF ────────────────────────────────────────────────────────────
  {
    id: "SSRF_FETCH",
    title: "Potential SSRF via user-controlled URL",
    description:
      "HTTP request made to a URL that includes user-controlled input. This could " +
      "allow Server-Side Request Forgery attacks to access internal services.",
    pattern:
      /(?:fetch|axios|request|http\.get|https\.get|got|needle)\s*\(\s*(?:.*?\+\s*(?:req\.|params\.|body\.|query\.|args\.|input|user)|`[^`]*\$\{.*?(?:req\.|params\.|body\.|query\.))/i,
    severity: SEVERITY.HIGH,
    category: VULN_CATEGORY.SSRF,
    remediation:
      "Validate and allowlist destination URLs/hosts. Block requests to private IP ranges " +
      "(10.x, 172.16.x, 192.168.x, 127.x, 169.254.x) and metadata endpoints.",
    cweIds: ["CWE-918"],
    owaspCategory: "A10:2021",
    appliesTo: [
      ".ts",
      ".js",
      ".jsx",
      ".tsx",
      ".mjs",
      ".cjs",
      ".py",
      ".go",
      ".java",
    ],
    excludeExts: [],
    confidence: 0.7,
    references: [],
    enabled: true,
  },

  // ── Insecure Crypto ─────────────────────────────────────────────────
  {
    id: "WEAK_CRYPTO_MD5",
    title: "Use of weak hash algorithm (MD5)",
    description:
      "MD5 is cryptographically broken and unsuitable for security purposes. " +
      "It is vulnerable to collision attacks and should not be used for password " +
      "hashing, integrity verification, or digital signatures.",
    pattern:
      /(?:createHash|hashlib\.md5|MD5|Digest::MD5|md5\()\s*\(\s*['"`]?md5/i,
    severity: SEVERITY.MEDIUM,
    category: VULN_CATEGORY.CRYPTO_WEAKNESS,
    remediation:
      "Use SHA-256 or SHA-3 for integrity checks, bcrypt/scrypt/argon2 for password hashing.",
    cweIds: ["CWE-327", "CWE-328"],
    owaspCategory: "A02:2021",
    appliesTo: [],
    excludeExts: [".md", ".txt", ".json"],
    confidence: 0.8,
    references: [],
    enabled: true,
  },
  {
    id: "WEAK_CRYPTO_SHA1",
    title: "Use of weak hash algorithm (SHA-1)",
    description:
      "SHA-1 is considered cryptographically weak. Collision attacks against SHA-1 " +
      "are practical and it should not be used for security-sensitive operations.",
    pattern:
      /(?:createHash|hashlib\.sha1|SHA1|Digest::SHA1)\s*\(\s*['"`]?sha-?1/i,
    severity: SEVERITY.LOW,
    category: VULN_CATEGORY.CRYPTO_WEAKNESS,
    remediation:
      "Use SHA-256 or SHA-3 instead. For password hashing, use bcrypt/scrypt/argon2.",
    cweIds: ["CWE-327", "CWE-328"],
    owaspCategory: "A02:2021",
    appliesTo: [],
    excludeExts: [".md", ".txt", ".json"],
    confidence: 0.7,
    references: [],
    enabled: true,
  },
  {
    id: "HARDCODED_CRYPTO_KEY",
    title: "Hardcoded cryptographic key",
    description:
      "Cryptographic key or secret appears to be hardcoded in source code. " +
      "Hardcoded keys are easily extractable and cannot be rotated without " +
      "a code deployment.",
    pattern:
      /(?:(?:secret|private|encryption|signing|jwt|api)[\s_-]*key|SECRET_KEY|PRIVATE_KEY)\s*[:=]\s*['"`][a-zA-Z0-9+/=_-]{16,}/i,
    severity: SEVERITY.HIGH,
    category: VULN_CATEGORY.SECRETS_EXPOSURE,
    remediation:
      "Store cryptographic keys in environment variables, a secrets manager (e.g. AWS Secrets Manager, " +
      "Vault, Doppler), or a hardware security module. Never commit keys to source control.",
    cweIds: ["CWE-798", "CWE-321"],
    owaspCategory: "A02:2021",
    appliesTo: [],
    excludeExts: [".md", ".txt"],
    confidence: 0.7,
    references: [],
    enabled: true,
  },

  // ── Insecure Patterns ───────────────────────────────────────────────
  {
    id: "CORS_WILDCARD",
    title: "Overly permissive CORS configuration",
    description:
      "Access-Control-Allow-Origin set to '*' allows any origin to make requests. " +
      "This can expose your API to cross-origin attacks if the endpoint handles " +
      "sensitive data or uses credentials.",
    pattern: /(?:Access-Control-Allow-Origin|cors\s*\(|origin\s*:)\s*['"`]?\*/i,
    severity: SEVERITY.MEDIUM,
    category: VULN_CATEGORY.CONFIGURATION_ISSUE,
    remediation:
      "Restrict CORS to specific trusted origins. If a wildcard is required, ensure " +
      "the endpoint does not use credentials (cookies, auth headers).",
    cweIds: ["CWE-942"],
    owaspCategory: "A05:2021",
    appliesTo: [
      ".ts",
      ".js",
      ".jsx",
      ".tsx",
      ".mjs",
      ".cjs",
      ".py",
      ".go",
      ".java",
      ".rb",
      ".php",
    ],
    excludeExts: [],
    confidence: 0.65,
    references: [],
    enabled: true,
  },
  {
    id: "INSECURE_HTTP",
    title: "Hardcoded HTTP URL (non-HTTPS)",
    description:
      "A hardcoded HTTP (non-HTTPS) URL was found. Data sent over HTTP is transmitted " +
      "in plaintext and can be intercepted by network attackers.",
    pattern: /['"`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|::1)/i,
    severity: SEVERITY.LOW,
    category: VULN_CATEGORY.INSECURE_PATTERN,
    remediation:
      "Use HTTPS for all external URLs. Configure HTTP Strict Transport Security (HSTS) " +
      "on your servers.",
    cweIds: ["CWE-319"],
    owaspCategory: "A02:2021",
    appliesTo: [],
    excludeExts: [".md", ".txt", ".css", ".scss"],
    confidence: 0.5,
    references: [],
    enabled: true,
  },
  {
    id: "DISABLED_TLS_VERIFY",
    title: "TLS/SSL certificate verification disabled",
    description:
      "SSL/TLS certificate verification is explicitly disabled, making the connection " +
      "vulnerable to man-in-the-middle attacks.",
    pattern:
      /(?:rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:0|false)|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0)/i,
    severity: SEVERITY.HIGH,
    category: VULN_CATEGORY.INSECURE_PATTERN,
    remediation:
      "Enable TLS certificate verification. If you need to work with self-signed certificates, " +
      "configure the CA certificate properly instead of disabling verification entirely.",
    cweIds: ["CWE-295"],
    owaspCategory: "A02:2021",
    appliesTo: [],
    excludeExts: [".md", ".txt"],
    confidence: 0.9,
    references: [],
    enabled: true,
  },
  {
    id: "DEBUG_MODE_PROD",
    title: "Debug mode potentially enabled in production",
    description:
      "Debug mode appears to be enabled. Running debug mode in production exposes " +
      "detailed error messages, stack traces, and potentially internal state to attackers.",
    pattern:
      /(?:DEBUG\s*[:=]\s*['"`]?(?:true|1|yes)|app\.debug\s*=\s*True|FLASK_DEBUG\s*=\s*1|debug\s*:\s*true)/i,
    severity: SEVERITY.MEDIUM,
    category: VULN_CATEGORY.CONFIGURATION_ISSUE,
    remediation:
      "Ensure debug mode is disabled in production environments. Use environment-specific " +
      "configuration files and never commit debug-enabled configs.",
    cweIds: ["CWE-489"],
    owaspCategory: "A05:2021",
    appliesTo: [],
    excludeExts: [".md", ".txt"],
    confidence: 0.5,
    references: [],
    enabled: true,
  },

  // ── Authentication & Authorization ──────────────────────────────────
  {
    id: "JWT_NONE_ALGO",
    title: "JWT configured without algorithm or using 'none'",
    description:
      "JWT verification configured without a specific algorithm or using the 'none' " +
      "algorithm. This allows attackers to forge tokens by stripping the signature.",
    pattern:
      /(?:algorithms?\s*[:=]\s*\[?\s*['"`]none|verify\s*[:=]\s*false|(?:jwt|jsonwebtoken).*?(?:algorithm|algo)\s*[:=]\s*['"`]?none)/i,
    severity: SEVERITY.CRITICAL,
    category: VULN_CATEGORY.AUTH_FLAW,
    remediation:
      "Always specify a strong algorithm (RS256, ES256, or HS256 with a strong secret). " +
      "Reject tokens with 'none' algorithm. Validate the algorithm in the token header.",
    cweIds: ["CWE-345", "CWE-347"],
    owaspCategory: "A07:2021",
    appliesTo: [],
    excludeExts: [".md", ".txt"],
    confidence: 0.85,
    references: [],
    enabled: true,
  },
  {
    id: "HARDCODED_PASSWORD",
    title: "Hardcoded password or credential",
    description:
      "A password, credential, or secret appears to be hardcoded in source code. " +
      "Hardcoded credentials can be extracted from compiled binaries, version control " +
      "history, and backups.",
    pattern:
      /(?:password|passwd|pwd|pass|secret|credential|auth_token)\s*[:=]\s*['"`][^'"`\s]{4,}/i,
    severity: SEVERITY.HIGH,
    category: VULN_CATEGORY.SECRETS_EXPOSURE,
    remediation:
      "Use environment variables or a secrets manager to store credentials. " +
      "Never hardcode passwords in source code.",
    cweIds: ["CWE-798", "CWE-259"],
    owaspCategory: "A07:2021",
    appliesTo: [],
    excludeExts: [".md", ".txt", ".json", ".yaml", ".yml", ".toml"],
    confidence: 0.6,
    references: [],
    enabled: true,
  },

  // ── Deserialization ─────────────────────────────────────────────────
  {
    id: "INSECURE_DESERIALIZATION_PICKLE",
    title: "Insecure deserialization via pickle",
    description:
      "Python's pickle module can execute arbitrary code during deserialization. " +
      "Never unpickle data from untrusted sources.",
    pattern: /(?:pickle\.loads?|cPickle\.loads?|shelve\.open)\s*\(/,
    severity: SEVERITY.HIGH,
    category: VULN_CATEGORY.DESERIALIZATION,
    remediation:
      "Use safe alternatives like JSON or protobuf for serialization. " +
      "If pickle is necessary, only unpickle data from fully trusted sources.",
    cweIds: ["CWE-502"],
    owaspCategory: "A08:2021",
    appliesTo: [".py"],
    excludeExts: [],
    confidence: 0.75,
    references: [],
    enabled: true,
  },
  {
    id: "INSECURE_DESERIALIZATION_YAML",
    title: "Insecure YAML loading",
    description:
      "yaml.load() without SafeLoader/safe_load can execute arbitrary Python code " +
      "embedded in YAML documents.",
    pattern:
      /yaml\.load\s*\([^)]*(?!Loader\s*=\s*(?:Safe|Base)Loader|safe_load)/,
    severity: SEVERITY.HIGH,
    category: VULN_CATEGORY.DESERIALIZATION,
    remediation:
      "Use yaml.safe_load() or yaml.load(data, Loader=SafeLoader) instead of yaml.load().",
    cweIds: ["CWE-502"],
    owaspCategory: "A08:2021",
    appliesTo: [".py"],
    excludeExts: [],
    confidence: 0.8,
    references: [],
    enabled: true,
  },

  // ── Information Disclosure ──────────────────────────────────────────
  {
    id: "STACK_TRACE_EXPOSURE",
    title: "Stack trace exposed to client",
    description:
      "Error stack traces appear to be sent to the client/response. Stack traces " +
      "reveal internal code structure, file paths, and library versions.",
    pattern:
      /(?:res\.(?:send|json|write)|response\.(?:send|json|write))\s*\(.*?(?:err\.stack|error\.stack|\.stack)/i,
    severity: SEVERITY.MEDIUM,
    category: VULN_CATEGORY.INFORMATION_DISCLOSURE,
    remediation:
      "Log stack traces server-side only. Return generic error messages to clients. " +
      "Use a structured error handler that differentiates between dev and production.",
    cweIds: ["CWE-209"],
    owaspCategory: "A04:2021",
    appliesTo: [".ts", ".js", ".jsx", ".tsx", ".mjs", ".cjs"],
    excludeExts: [],
    confidence: 0.7,
    references: [],
    enabled: true,
  },
  {
    id: "CONSOLE_LOG_SENSITIVE",
    title: "Potentially sensitive data in console output",
    description:
      "Sensitive data (passwords, tokens, keys) appears to be logged via console. " +
      "Console output may be captured in log files accessible to unauthorized parties.",
    pattern:
      /console\.(?:log|info|warn|error|debug)\s*\(.*?(?:password|token|secret|apiKey|api_key|private_key|access_token|refresh_token|authorization)/i,
    severity: SEVERITY.MEDIUM,
    category: VULN_CATEGORY.INFORMATION_DISCLOSURE,
    remediation:
      "Remove or redact sensitive data from log statements. Use a structured logger " +
      "with automatic PII redaction.",
    cweIds: ["CWE-532"],
    owaspCategory: "A09:2021",
    appliesTo: [".ts", ".js", ".jsx", ".tsx", ".mjs", ".cjs"],
    excludeExts: [],
    confidence: 0.55,
    references: [],
    enabled: true,
  },

  // ── Race Conditions ─────────────────────────────────────────────────
  {
    id: "RACE_CONDITION_TOCTOU",
    title: "Potential TOCTOU race condition (check-then-use on file system)",
    description:
      "File existence is checked before use, creating a time-of-check to " +
      "time-of-use (TOCTOU) race condition. An attacker could modify or replace " +
      "the file between the check and the use.",
    pattern:
      /(?:existsSync|accessSync|statSync)\s*\([^)]+\)[\s\S]{0,100}(?:readFileSync|writeFileSync|unlinkSync|createReadStream)/,
    severity: SEVERITY.LOW,
    category: VULN_CATEGORY.RACE_CONDITION,
    remediation:
      "Use atomic operations where possible. Open the file directly and handle ENOENT " +
      "errors rather than checking existence first.",
    cweIds: ["CWE-367"],
    owaspCategory: "A04:2021",
    appliesTo: [".ts", ".js", ".jsx", ".tsx", ".mjs", ".cjs"],
    excludeExts: [],
    confidence: 0.4,
    references: [],
    enabled: true,
  },

  // ── Privilege Escalation / Permissions ──────────────────────────────
  {
    id: "OVERLY_PERMISSIVE_PERMS",
    title: "Overly permissive file/directory permissions",
    description:
      "File or directory created with overly permissive mode (e.g. 0777, 0666). " +
      "This allows any user on the system to read, write, or execute the file.",
    pattern: /(?:chmod|mode|permissions?)\s*[:=]\s*['"`]?0?(?:777|776|766|666)/,
    severity: SEVERITY.MEDIUM,
    category: VULN_CATEGORY.PRIVILEGE_ESCALATION,
    remediation:
      "Use the principle of least privilege. Set file permissions to the minimum " +
      "required (e.g. 0600 for owner-only read/write, 0644 for public-readable files).",
    cweIds: ["CWE-732"],
    owaspCategory: "A01:2021",
    appliesTo: [],
    excludeExts: [".md", ".txt"],
    confidence: 0.7,
    references: [],
    enabled: true,
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// Built-in Secret Detection Patterns
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Default set of secret detection patterns.
 *
 * Each pattern matches a known secret format (API keys, tokens, passwords).
 * These are checked line-by-line against all scannable files.
 */
export const BUILTIN_SECRET_PATTERNS: SecretPattern[] = [
  {
    id: "AWS_ACCESS_KEY",
    name: "AWS Access Key ID",
    pattern: /(?:^|[^A-Z0-9])(AKIA[0-9A-Z]{16})(?:[^A-Z0-9]|$)/,
    severity: SEVERITY.CRITICAL,
    confidence: 0.95,
    description:
      "AWS Access Key ID detected. This can provide programmatic access to AWS services.",
    remediation:
      "Immediately rotate the key in the AWS IAM console. Use IAM roles, SSO, or " +
      "AWS Secrets Manager instead of embedding keys in code.",
    cweIds: ["CWE-798"],
    appliesTo: [],
    excludeExts: [".md"],
  },
  {
    id: "AWS_SECRET_KEY",
    name: "AWS Secret Access Key",
    pattern:
      /(?:aws_secret_access_key|aws_secret|secret_key)\s*[:=]\s*['"`]?([A-Za-z0-9/+=]{40})['"`]?/i,
    severity: SEVERITY.CRITICAL,
    confidence: 0.9,
    description:
      "AWS Secret Access Key detected. Combined with an Access Key ID, this provides full AWS access.",
    remediation:
      "Immediately rotate both the access key and secret key. " +
      "Store credentials in environment variables or AWS Secrets Manager.",
    cweIds: ["CWE-798"],
    appliesTo: [],
    excludeExts: [".md"],
  },
  {
    id: "GITHUB_TOKEN",
    name: "GitHub Personal Access Token",
    pattern:
      /(?:^|[^a-zA-Z0-9_])(gh[ps]_[A-Za-z0-9_]{36,255})(?:[^a-zA-Z0-9_]|$)/,
    severity: SEVERITY.CRITICAL,
    confidence: 0.95,
    description: "GitHub personal access token or OAuth app token detected.",
    remediation:
      "Revoke the token immediately on GitHub and create a new one. " +
      "Use GitHub Apps with fine-grained permissions instead of PATs where possible.",
    cweIds: ["CWE-798"],
    appliesTo: [],
    excludeExts: [".md"],
  },
  {
    id: "GITHUB_FINE_GRAINED",
    name: "GitHub Fine-Grained Token",
    pattern:
      /(?:^|[^a-zA-Z0-9_])(github_pat_[A-Za-z0-9_]{22,255})(?:[^a-zA-Z0-9_]|$)/,
    severity: SEVERITY.CRITICAL,
    confidence: 0.95,
    description: "GitHub fine-grained personal access token detected.",
    remediation:
      "Revoke the token immediately on GitHub Settings → Developer settings → Personal access tokens.",
    cweIds: ["CWE-798"],
    appliesTo: [],
    excludeExts: [".md"],
  },
  {
    id: "GENERIC_API_KEY",
    name: "Generic API Key",
    pattern:
      /(?:api[_-]?key|apikey|api[_-]?secret|api[_-]?token)\s*[:=]\s*['"`]([a-zA-Z0-9_\-]{20,})['"`]/i,
    severity: SEVERITY.HIGH,
    confidence: 0.6,
    description: "A generic API key or token was detected in source code.",
    remediation:
      "Move API keys to environment variables or a secrets manager. " +
      "Add the key pattern to .gitignore and rotate the exposed key.",
    cweIds: ["CWE-798"],
    appliesTo: [],
    excludeExts: [".md", ".txt"],
  },
  {
    id: "PRIVATE_KEY_PEM",
    name: "Private Key (PEM format)",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    severity: SEVERITY.CRITICAL,
    confidence: 0.95,
    description: "A PEM-encoded private key was found in the codebase.",
    remediation:
      "Remove the private key from the repository immediately. Rotate the key pair. " +
      "Store private keys in a secrets manager or hardware security module.",
    cweIds: ["CWE-321", "CWE-798"],
    appliesTo: [],
    excludeExts: [],
  },
  {
    id: "SLACK_TOKEN",
    name: "Slack API Token",
    pattern:
      /(?:^|[^a-zA-Z0-9_])(xox[baprs]-[0-9a-zA-Z]{10,})(?:[^a-zA-Z0-9_]|$)/,
    severity: SEVERITY.HIGH,
    confidence: 0.9,
    description: "A Slack API token was detected.",
    remediation:
      "Revoke the token in Slack workspace settings. Use environment variables for Slack tokens.",
    cweIds: ["CWE-798"],
    appliesTo: [],
    excludeExts: [".md"],
  },
  {
    id: "STRIPE_KEY",
    name: "Stripe API Key",
    pattern:
      /(?:^|[^a-zA-Z0-9_])(sk_(?:live|test)_[0-9a-zA-Z]{24,})(?:[^a-zA-Z0-9_]|$)/,
    severity: SEVERITY.CRITICAL,
    confidence: 0.95,
    description:
      "A Stripe secret API key was detected. This provides access to payment operations.",
    remediation:
      "Roll the key immediately in the Stripe dashboard. " +
      "Use restricted keys with minimal permissions and store them in environment variables.",
    cweIds: ["CWE-798"],
    appliesTo: [],
    excludeExts: [".md"],
  },
  {
    id: "GOOGLE_API_KEY",
    name: "Google API Key",
    pattern: /(?:^|[^a-zA-Z0-9_])(AIza[0-9A-Za-z_-]{35})(?:[^a-zA-Z0-9_]|$)/,
    severity: SEVERITY.HIGH,
    confidence: 0.9,
    description: "A Google API key was detected.",
    remediation:
      "Restrict the key's usage in the Google Cloud Console (HTTP referrer, IP address, or API restrictions). " +
      "Rotate the key and store it in environment variables.",
    cweIds: ["CWE-798"],
    appliesTo: [],
    excludeExts: [".md"],
  },
  {
    id: "SENDGRID_KEY",
    name: "SendGrid API Key",
    pattern:
      /(?:^|[^a-zA-Z0-9_])(SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43})(?:[^a-zA-Z0-9_]|$)/,
    severity: SEVERITY.HIGH,
    confidence: 0.95,
    description: "A SendGrid API key was detected.",
    remediation:
      "Revoke and rotate the key in the SendGrid dashboard. Store in environment variables.",
    cweIds: ["CWE-798"],
    appliesTo: [],
    excludeExts: [".md"],
  },
  {
    id: "TWILIO_KEY",
    name: "Twilio API Key",
    pattern: /(?:^|[^a-zA-Z0-9_])(SK[0-9a-fA-F]{32})(?:[^a-zA-Z0-9_]|$)/,
    severity: SEVERITY.HIGH,
    confidence: 0.7,
    description: "A Twilio API key was detected.",
    remediation:
      "Revoke the key in the Twilio console. Store credentials in environment variables.",
    cweIds: ["CWE-798"],
    appliesTo: [],
    excludeExts: [".md"],
  },
  {
    id: "GENERIC_PASSWORD",
    name: "Hardcoded Password Assignment",
    pattern:
      /(?:password|passwd|pwd|pass_word)\s*[:=]\s*['"`](?!['"` ])[^'"`]{6,}['"`]/i,
    severity: SEVERITY.HIGH,
    confidence: 0.5,
    description: "A password appears to be hardcoded in source code.",
    remediation:
      "Move passwords to environment variables or a secrets manager. " +
      "Use .env files (not committed) for local development.",
    cweIds: ["CWE-798", "CWE-259"],
    appliesTo: [],
    excludeExts: [".md", ".txt", ".json", ".yaml", ".yml"],
  },
  {
    id: "CONNECTION_STRING",
    name: "Database Connection String",
    pattern:
      /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mssql|redis|amqp|jdbc):\/\/[^:\s]+:[^@\s]+@[^\s'"]+/i,
    severity: SEVERITY.HIGH,
    confidence: 0.85,
    description:
      "A database connection string with embedded credentials was detected.",
    remediation:
      "Store connection strings in environment variables. " +
      "Use connection pooling services or secrets managers for database credentials.",
    cweIds: ["CWE-798"],
    appliesTo: [],
    excludeExts: [".md"],
  },
  {
    id: "JWT_SECRET",
    name: "JWT Secret / Signing Key",
    pattern:
      /(?:jwt[_-]?secret|jwt[_-]?key|signing[_-]?key|token[_-]?secret)\s*[:=]\s*['"`]([a-zA-Z0-9_\-/+=]{16,})['"`]/i,
    severity: SEVERITY.HIGH,
    confidence: 0.7,
    description:
      "A JWT signing secret or key was found hardcoded in source code.",
    remediation:
      "Use environment variables for JWT secrets. Rotate the secret immediately and " +
      "invalidate existing tokens.",
    cweIds: ["CWE-798"],
    appliesTo: [],
    excludeExts: [".md", ".txt"],
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// Analysis Pipelines
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Run all analysis pipelines against a scan result.
 *
 * This is the main entry point for the analyzer. It runs pattern matching,
 * secret detection, and dependency auditing in sequence, then merges and
 * deduplicates the results.
 *
 * @param scanResult - The output of scanProject().
 * @param options    - Configuration options.
 * @returns A complete AnalysisResult with all findings.
 */
export async function analyzeProject(
  scanResult: ScanResult,
  options: AnalyzeOptions = {},
): Promise<AnalysisResult> {
  const startMs = Date.now();
  const warnings: string[] = [];

  const enablePatterns = options.enablePatterns ?? true;
  const enableSecrets = options.enableSecrets ?? true;
  const enableDeps = options.enableDependencies ?? true;
  const minSeverity = options.minSeverity ?? SEVERITY.INFO;
  const minConfidence = options.minConfidence ?? 0.3;
  const maxPerFile = options.maxFindingsPerFile ?? 50;

  // Combine built-in and custom rules
  const patternRules = [
    ...BUILTIN_PATTERN_RULES.filter((r) => r.enabled),
    ...(options.customRules ?? []),
  ];

  const secretPatterns = [
    ...BUILTIN_SECRET_PATTERNS,
    ...(options.customSecretPatterns ?? []),
  ];

  // ── Run pipelines ─────────────────────────────────────────────────

  let patternFindings: Finding[] = [];
  let secretFindings: Finding[] = [];
  let dependencyFindings: Finding[] = [];
  let analyzedCount = 0;

  // Pattern matching + secret detection (per file)
  for (let i = 0; i < scanResult.files.length; i++) {
    if (options.signal?.aborted) {
      warnings.push("Analysis cancelled by signal.");
      break;
    }

    const file = scanResult.files[i]!;

    if (!file.readOk || !file.content) continue;

    let filePatternFindings: Finding[] = [];
    let fileSecretFindings: Finding[] = [];

    if (enablePatterns) {
      filePatternFindings = analyzeFilePatterns(file, patternRules, maxPerFile);
    }

    if (enableSecrets) {
      fileSecretFindings = analyzeFileSecrets(file, secretPatterns, maxPerFile);
    }

    patternFindings.push(...filePatternFindings);
    secretFindings.push(...fileSecretFindings);

    analyzedCount++;

    if (options.onProgress) {
      options.onProgress(i + 1, scanResult.files.length, file.relativePath);
    }
  }

  // Dependency audit
  if (enableDeps && scanResult.manifests.length > 0) {
    dependencyFindings = analyzeManifests(scanResult.manifests);
  }

  // ── Filter by severity and confidence ─────────────────────────────

  const severityIdx = severityIndex(minSeverity);

  const filterFinding = (f: Finding): boolean => {
    const sevIdx = severityIndex(f.severity);
    return sevIdx <= severityIdx && f.confidence >= minConfidence;
  };

  patternFindings = patternFindings.filter(filterFinding);
  secretFindings = secretFindings.filter(filterFinding);
  dependencyFindings = dependencyFindings.filter(filterFinding);

  // ── Merge & deduplicate ───────────────────────────────────────────

  const allFindings = mergeFindings(
    patternFindings,
    secretFindings,
    dependencyFindings,
  );

  const durationMs = Date.now() - startMs;

  return {
    findings: allFindings,
    patternFindings,
    secretFindings,
    dependencyFindings,
    filesAnalyzed: analyzedCount,
    durationMs,
    warnings,
  };
}

/**
 * Analyze a single file against all pattern rules.
 */
export function analyzeFilePatterns(
  file: ScannedFile,
  rules: PatternRule[] = BUILTIN_PATTERN_RULES,
  maxFindings: number = 50,
): Finding[] {
  const findings: Finding[] = [];
  const lines = file.lines.length > 0 ? file.lines : file.content.split("\n");
  const ext = file.ext.toLowerCase();

  for (const rule of rules) {
    if (!rule.enabled) continue;

    // Check if rule applies to this file extension
    if (rule.appliesTo.length > 0 && !rule.appliesTo.includes(ext)) {
      continue;
    }
    if (rule.excludeExts.includes(ext)) {
      continue;
    }

    // Check each line
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (findings.length >= maxFindings) break;

      const line = lines[lineIdx]!;

      // Skip comment-only lines (basic heuristic)
      const trimmed = line.trim();
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("<!--")
      ) {
        continue;
      }

      if (rule.pattern.test(line)) {
        // Extract a snippet (the matched line + a few surrounding lines)
        const snippetStart = Math.max(0, lineIdx - 1);
        const snippetEnd = Math.min(lines.length, lineIdx + 2);
        const snippet = lines.slice(snippetStart, snippetEnd).join("\n");

        const finding = createFinding({
          title: rule.title,
          description: rule.description,
          severity: rule.severity,
          category: rule.category,
          confidence: rule.confidence,
          locations: [
            {
              file: file.relativePath,
              startLine: lineIdx + 1,
              endLine: lineIdx + 1,
              snippet,
            },
          ],
          remediation: rule.remediation,
          source: "pattern-match",
          cweIds: rule.cweIds,
          owaspCategory: rule.owaspCategory,
          references: rule.references,
          metadata: { ruleId: rule.id },
        });

        findings.push(finding);

        // Don't match the same rule again on adjacent lines
        // (skip a few lines to avoid duplicate noise)
        lineIdx += 2;
      }
    }

    if (findings.length >= maxFindings) break;
  }

  return findings;
}

/**
 * Analyze a single file for exposed secrets.
 */
export function analyzeFileSecrets(
  file: ScannedFile,
  patterns: SecretPattern[] = BUILTIN_SECRET_PATTERNS,
  maxFindings: number = 50,
): Finding[] {
  const findings: Finding[] = [];
  const lines = file.lines.length > 0 ? file.lines : file.content.split("\n");
  const ext = file.ext.toLowerCase();

  for (const pattern of patterns) {
    // Check if pattern applies to this file extension
    if (pattern.appliesTo.length > 0 && !pattern.appliesTo.includes(ext)) {
      continue;
    }
    if (pattern.excludeExts.includes(ext)) {
      continue;
    }

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (findings.length >= maxFindings) break;

      const line = lines[lineIdx]!;

      // Skip comment-only lines
      const trimmed = line.trim();
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("<!--")
      ) {
        continue;
      }

      // Skip test/example patterns
      if (isLikelyPlaceholder(line)) {
        continue;
      }

      if (pattern.pattern.test(line)) {
        // Redact the secret in the snippet
        const redactedLine = redactSecrets(line);

        const finding = createFinding({
          title: `${pattern.name} detected`,
          description: pattern.description,
          severity: pattern.severity,
          category: VULN_CATEGORY.SECRETS_EXPOSURE,
          confidence: pattern.confidence,
          locations: [
            {
              file: file.relativePath,
              startLine: lineIdx + 1,
              endLine: lineIdx + 1,
              snippet: redactedLine,
            },
          ],
          remediation: pattern.remediation,
          source: "secret-detection",
          cweIds: pattern.cweIds,
          metadata: { patternId: pattern.id },
        });

        findings.push(finding);
      }
    }

    if (findings.length >= maxFindings) break;
  }

  return findings;
}

/**
 * Analyze dependency manifests for security issues.
 *
 * Checks for:
 * - Wildcard/latest version pins
 * - Known risky package names (typosquatting patterns)
 * - Large dependency counts (attack surface)
 * - Suspicious scripts in package.json
 */
export function analyzeManifests(manifests: ScannedManifest[]): Finding[] {
  const findings: Finding[] = [];

  for (const manifest of manifests) {
    const file = manifest.file;

    // ── Wildcard version pins ────────────────────────────────────────
    const allDeps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };

    for (const [depName, version] of Object.entries(allDeps)) {
      if (
        version === "*" ||
        version === "latest" ||
        version === "x" ||
        version === ""
      ) {
        findings.push(
          createFinding({
            title: `Unpinned dependency: ${depName}`,
            description:
              `The dependency "${depName}" uses a wildcard or "latest" version ` +
              `("${version}"). This means any version — including malicious ones — ` +
              `could be installed.`,
            severity: SEVERITY.MEDIUM,
            category: VULN_CATEGORY.DEPENDENCY_ISSUE,
            confidence: 0.9,
            locations: [
              {
                file: file.relativePath,
              },
            ],
            remediation:
              `Pin "${depName}" to a specific version or semver range ` +
              `(e.g. "^1.2.3" or "~1.2.3"). Run \`npm audit\` or your ` +
              `package manager's audit command to check for known vulnerabilities.`,
            source: "dependency-audit",
            cweIds: ["CWE-829"],
            metadata: { dependency: depName, version },
          }),
        );
      }
    }

    // ── Suspicious npm scripts (package.json only) ───────────────────
    if (manifest.type === "npm" && manifest.parsed) {
      const scripts = manifest.parsed["scripts"];
      if (scripts && typeof scripts === "object") {
        for (const [scriptName, scriptCmd] of Object.entries(
          scripts as Record<string, string>,
        )) {
          if (typeof scriptCmd !== "string") continue;

          // Check for suspicious script patterns
          if (
            /curl\s.*\|\s*(?:ba)?sh/i.test(scriptCmd) ||
            /wget\s.*\|\s*(?:ba)?sh/i.test(scriptCmd) ||
            /\beval\b/i.test(scriptCmd) ||
            /base64\s+(?:-d|--decode)/i.test(scriptCmd)
          ) {
            findings.push(
              createFinding({
                title: `Suspicious script: "${scriptName}"`,
                description:
                  `The npm script "${scriptName}" contains potentially dangerous commands ` +
                  `(remote code execution, eval, or base64 decoding). This could be a ` +
                  `supply chain attack vector.`,
                severity: SEVERITY.HIGH,
                category: VULN_CATEGORY.DEPENDENCY_ISSUE,
                confidence: 0.75,
                locations: [
                  {
                    file: file.relativePath,
                    snippet: `"${scriptName}": "${scriptCmd}"`,
                  },
                ],
                remediation:
                  "Review the script command carefully. Avoid piping remote content " +
                  "to shell interpreters. If the script is from a trusted source, " +
                  "consider downloading and verifying the script before execution.",
                source: "dependency-audit",
                cweIds: ["CWE-829", "CWE-506"],
                metadata: { scriptName, scriptCmd },
              }),
            );
          }

          // Preinstall/postinstall hooks are common supply chain attack vectors
          if (
            (scriptName === "preinstall" || scriptName === "postinstall") &&
            scriptCmd.length > 0
          ) {
            findings.push(
              createFinding({
                title: `Lifecycle script hook: "${scriptName}"`,
                description:
                  `The package has a "${scriptName}" script that runs automatically ` +
                  `during installation. Install hooks are the most common vector for ` +
                  `npm supply chain attacks.`,
                severity: SEVERITY.INFO,
                category: VULN_CATEGORY.DEPENDENCY_ISSUE,
                confidence: 0.4,
                locations: [
                  {
                    file: file.relativePath,
                    snippet: `"${scriptName}": "${scriptCmd}"`,
                  },
                ],
                remediation:
                  "Review lifecycle scripts carefully. Consider using --ignore-scripts " +
                  "flag and manually running necessary post-install steps.",
                source: "dependency-audit",
                cweIds: ["CWE-829"],
                metadata: { scriptName },
              }),
            );
          }
        }
      }
    }

    // ── Large dependency count warning ───────────────────────────────
    const totalDeps = Object.keys(manifest.dependencies).length;
    if (totalDeps > 100) {
      findings.push(
        createFinding({
          title: `Large dependency count (${totalDeps} dependencies)`,
          description:
            `This project has ${totalDeps} direct dependencies, creating a large ` +
            `attack surface. Each dependency (and its transitive dependencies) is ` +
            `a potential supply chain risk.`,
          severity: SEVERITY.INFO,
          category: VULN_CATEGORY.DEPENDENCY_ISSUE,
          confidence: 0.6,
          locations: [
            {
              file: file.relativePath,
            },
          ],
          remediation:
            "Audit your dependencies and remove unused ones. Consider alternatives " +
            "with fewer transitive dependencies. Run regular dependency audits.",
          source: "dependency-audit",
          cweIds: ["CWE-829"],
          metadata: { dependencyCount: totalDeps },
        }),
      );
    }
  }

  return findings;
}

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Get the numeric index of a severity level for comparison.
 * Lower index = more severe.
 */
function severityIndex(severity: Severity): number {
  const idx = (SEVERITY_ORDER as readonly string[]).indexOf(severity);
  return idx === -1 ? SEVERITY_ORDER.length : idx;
}

/**
 * Check if a line likely contains a placeholder/example value rather
 * than a real secret.
 */
function isLikelyPlaceholder(line: string): boolean {
  const lower = line.toLowerCase();
  return (
    lower.includes("example") ||
    lower.includes("placeholder") ||
    lower.includes("your-") ||
    lower.includes("your_") ||
    lower.includes("<your") ||
    lower.includes("xxx") ||
    lower.includes("changeme") ||
    lower.includes("replace") ||
    lower.includes("todo") ||
    lower.includes("fixme") ||
    lower.includes("dummy") ||
    lower.includes("sample") ||
    lower.includes("test") ||
    lower.includes("mock") ||
    /['"`]\*+['"`]/.test(line) || // "****"
    /['"`]\.{3,}['"`]/.test(line) // "..."
  );
}

/**
 * Redact potential secrets in a line for safe display in findings.
 *
 * Replaces long alphanumeric strings that look like secrets with
 * a redacted version showing only the first 4 and last 4 characters.
 */
function redactSecrets(line: string): string {
  return line.replace(
    /(['"`])([a-zA-Z0-9_\-/+=]{12,})(['"`])/g,
    (match, q1, secret: string, q2) => {
      if (secret.length <= 12) return match;
      const prefix = secret.slice(0, 4);
      const suffix = secret.slice(-4);
      const masked = "*".repeat(Math.min(secret.length - 8, 20));
      return `${q1}${prefix}${masked}${suffix}${q2}`;
    },
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Quick Analysis (single file, no scan result needed)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Quick-analyze a single file without needing a full ScanResult.
 *
 * Useful for targeted analysis when the user specifies @path.
 */
export function quickAnalyzeFile(
  file: ScannedFile,
  options: AnalyzeOptions = {},
): Finding[] {
  const enablePatterns = options.enablePatterns ?? true;
  const enableSecrets = options.enableSecrets ?? true;
  const maxPerFile = options.maxFindingsPerFile ?? 50;

  const patternRules = [
    ...BUILTIN_PATTERN_RULES.filter((r) => r.enabled),
    ...(options.customRules ?? []),
  ];

  const secretPats = [
    ...BUILTIN_SECRET_PATTERNS,
    ...(options.customSecretPatterns ?? []),
  ];

  let findings: Finding[] = [];

  if (enablePatterns) {
    findings.push(...analyzeFilePatterns(file, patternRules, maxPerFile));
  }

  if (enableSecrets) {
    findings.push(...analyzeFileSecrets(file, secretPats, maxPerFile));
  }

  return mergeFindings(findings);
}

// ═════════════════════════════════════════════════════════════════════════════
// Rule Management
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Get the complete list of built-in pattern rules.
 */
export function getBuiltinRules(): PatternRule[] {
  return [...BUILTIN_PATTERN_RULES];
}

/**
 * Get the complete list of built-in secret patterns.
 */
export function getBuiltinSecretPatterns(): SecretPattern[] {
  return [...BUILTIN_SECRET_PATTERNS];
}

/**
 * Get a summary of available rules.
 */
export function getRuleSummary(): {
  patternRules: number;
  secretPatterns: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
} {
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};

  for (const rule of BUILTIN_PATTERN_RULES) {
    byCategory[rule.category] = (byCategory[rule.category] ?? 0) + 1;
    bySeverity[rule.severity] = (bySeverity[rule.severity] ?? 0) + 1;
  }

  for (const pattern of BUILTIN_SECRET_PATTERNS) {
    const cat = VULN_CATEGORY.SECRETS_EXPOSURE;
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    bySeverity[pattern.severity] = (bySeverity[pattern.severity] ?? 0) + 1;
  }

  return {
    patternRules: BUILTIN_PATTERN_RULES.length,
    secretPatterns: BUILTIN_SECRET_PATTERNS.length,
    byCategory,
    bySeverity,
  };
}
