// ─────────────────────────────────────────────────────────────────────────────
// Crack Code — Report Generator
// ─────────────────────────────────────────────────────────────────────────────
// Generates exportable reports from findings in multiple formats:
//   • JSON  — machine-readable, full-fidelity
//   • Markdown — human-readable, suitable for PRs and docs
//   • SARIF — Static Analysis Results Interchange Format (v2.1.0)
//
// Reports are generated from an array of Finding objects and scan metadata.
// The tool NEVER modifies source files — these reports are purely output
// artifacts written to a user-specified path.
//
// Zero external dependencies.
// ─────────────────────────────────────────────────────────────────────────────

import { resolve, basename, dirname } from "node:path";
import {
  APP_NAME,
  APP_VERSION,
  APP_BIN,
  APP_DESCRIPTION,
  SEVERITY,
  SEVERITY_ORDER,
  SEVERITY_LABELS,
  type Severity,
} from "../utils/constants.js";

import { safeWriteFile, ensureDir } from "../utils/fs.js";

import type {
  Finding,
  AffectedLocation,
  FindingsSummary,
  FindingSource,
} from "./findings.js";

import {
  summarizeFindings,
  formatCategoryLabel,
  getSeverityLabel,
  countBySeverity,
  countByCategory,
  getAffectedFiles,
  sortFindings,
} from "./findings.js";

// ── Report Types ────────────────────────────────────────────────────────────

/** Supported report output formats */
export type ReportFormat = "json" | "markdown" | "sarif";

/** Metadata about the scan that produced the findings */
export interface ReportMeta {
  /** Target path that was scanned */
  targetPath: string;
  /** Total files discovered in the target */
  totalFiles: number;
  /** Number of files actually scanned */
  scannedFiles: number;
  /** Scan duration in milliseconds */
  durationMs: number;
  /** ISO 8601 timestamp when the scan started */
  startedAt: string;
  /** ISO 8601 timestamp when the scan completed */
  completedAt: string;
  /** The AI provider used (if AI analysis was involved) */
  provider?: string;
  /** The model used (if AI analysis was involved) */
  model?: string;
  /** Git branch, if available */
  branch?: string;
  /** Git commit hash, if available */
  commitHash?: string;
  /** Session ID */
  sessionId?: string;
}

/** A complete report ready for export */
export interface Report {
  /** Report format */
  format: ReportFormat;
  /** The generated report content (string) */
  content: string;
  /** Suggested filename */
  suggestedFilename: string;
  /** Number of findings included */
  findingCount: number;
  /** Summary statistics */
  summary: FindingsSummary;
  /** When the report was generated */
  generatedAt: string;
}

// ── Report Generation ───────────────────────────────────────────────────────

/**
 * Generate a report in the specified format.
 *
 * @param findings - The findings to include.
 * @param meta     - Scan metadata.
 * @param format   - Output format: "json" | "markdown" | "sarif"
 * @returns A Report object containing the rendered content.
 */
export function generateReport(
  findings: Finding[],
  meta: ReportMeta,
  format: ReportFormat = "json",
): Report {
  const sorted = sortFindings(findings);
  const summary = summarizeFindings(sorted);
  const generatedAt = new Date().toISOString();

  let content: string;
  let suggestedFilename: string;

  switch (format) {
    case "json":
      content = generateJSONReport(sorted, meta, summary, generatedAt);
      suggestedFilename = buildFilename(meta, "json");
      break;
    case "markdown":
      content = generateMarkdownReport(sorted, meta, summary, generatedAt);
      suggestedFilename = buildFilename(meta, "md");
      break;
    case "sarif":
      content = generateSARIFReport(sorted, meta, summary, generatedAt);
      suggestedFilename = buildFilename(meta, "sarif.json");
      break;
    default:
      content = generateJSONReport(sorted, meta, summary, generatedAt);
      suggestedFilename = buildFilename(meta, "json");
  }

  return {
    format,
    content,
    suggestedFilename,
    findingCount: sorted.length,
    summary,
    generatedAt,
  };
}

/**
 * Generate a report and write it to disk.
 *
 * @param findings  - The findings to include.
 * @param meta      - Scan metadata.
 * @param format    - Output format.
 * @param outputDir - Directory to write the report file to.
 * @returns The written file path and the Report object.
 */
export async function generateAndWriteReport(
  findings: Finding[],
  meta: ReportMeta,
  format: ReportFormat,
  outputDir: string,
): Promise<{ filePath: string; report: Report }> {
  const report = generateReport(findings, meta, format);
  const filePath = resolve(outputDir, report.suggestedFilename);

  await ensureDir(outputDir);
  await safeWriteFile(filePath, report.content);

  return { filePath, report };
}

/**
 * Generate reports in multiple formats simultaneously.
 *
 * @param findings - The findings to include.
 * @param meta     - Scan metadata.
 * @param formats  - Array of formats to generate.
 * @returns Map of format → Report.
 */
export function generateMultiFormatReports(
  findings: Finding[],
  meta: ReportMeta,
  formats: ReportFormat[] = ["json", "markdown"],
): Map<ReportFormat, Report> {
  const reports = new Map<ReportFormat, Report>();
  for (const format of formats) {
    reports.set(format, generateReport(findings, meta, format));
  }
  return reports;
}

// ── Filename Builder ────────────────────────────────────────────────────────

/**
 * Build a sensible report filename from scan metadata.
 *
 * Pattern: crack-code-report-{project}-{date}.{ext}
 */
function buildFilename(meta: ReportMeta, ext: string): string {
  const projectName = sanitizeFilename(basename(meta.targetPath) || "project");
  const dateStr = meta.completedAt
    ? meta.completedAt.split("T")[0]
    : new Date().toISOString().split("T")[0];

  return `crack-code-report-${projectName}-${dateStr}.${ext}`;
}

/**
 * Sanitize a string for use as a filename component.
 */
function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON Report
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a full-fidelity JSON report.
 *
 * The JSON structure contains:
 * - Header with tool info and generation timestamp
 * - Scan metadata
 * - Summary statistics
 * - Full findings array (sorted by severity)
 */
function generateJSONReport(
  findings: Finding[],
  meta: ReportMeta,
  summary: FindingsSummary,
  generatedAt: string,
): string {
  const report = {
    $schema: "https://crack-code.dev/schemas/report-v1.json",
    tool: {
      name: APP_NAME,
      version: APP_VERSION,
      binary: APP_BIN,
      description: APP_DESCRIPTION,
    },
    generatedAt,
    scan: {
      targetPath: meta.targetPath,
      totalFiles: meta.totalFiles,
      scannedFiles: meta.scannedFiles,
      durationMs: meta.durationMs,
      durationSec: Math.round((meta.durationMs / 1000) * 10) / 10,
      startedAt: meta.startedAt,
      completedAt: meta.completedAt,
      provider: meta.provider ?? null,
      model: meta.model ?? null,
      branch: meta.branch ?? null,
      commitHash: meta.commitHash ?? null,
      sessionId: meta.sessionId ?? null,
    },
    summary: {
      totalFindings: summary.totalFindings,
      highestSeverity: summary.highestSeverity,
      averageConfidence: summary.averageConfidence,
      affectedFileCount: summary.affectedFileCount,
      affectedFiles: summary.affectedFiles,
      bySeverity: summary.bySeverity,
      byCategory: summary.byCategory,
      bySource: summary.bySource,
      categories: summary.categories,
    },
    findings: findings.map((f) => ({
      id: f.id,
      title: f.title,
      description: f.description,
      severity: f.severity,
      category: f.category,
      confidence: f.confidence,
      locations: f.locations.map((loc) => ({
        file: loc.file,
        startLine: loc.startLine ?? null,
        endLine: loc.endLine ?? null,
        column: loc.column ?? null,
        snippet: loc.snippet ?? null,
      })),
      remediation: f.remediation,
      aiPrompt: f.aiPrompt,
      cweIds: f.cweIds,
      owaspCategory: f.owaspCategory ?? null,
      references: f.references,
      source: f.source,
      createdAt: f.createdAt,
      metadata: f.metadata,
    })),
  };

  return JSON.stringify(report, null, 2) + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown Report
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a human-readable Markdown report.
 *
 * Designed to be pasted into GitHub PRs, wiki pages, or documentation.
 * Includes a table of contents, summary statistics, and detailed findings
 * with code snippets and remediation guidance.
 */
function generateMarkdownReport(
  findings: Finding[],
  meta: ReportMeta,
  summary: FindingsSummary,
  generatedAt: string,
): string {
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────

  lines.push(`# \uf132 ${APP_NAME} — Security Analysis Report`);
  lines.push("");
  lines.push(`> Generated by **${APP_NAME}** v${APP_VERSION}`);
  lines.push(`> ${generatedAt}`);
  lines.push("");

  // ── Table of Contents ───────────────────────────────────────────────

  lines.push("## Table of Contents");
  lines.push("");
  lines.push("- [Scan Information](#scan-information)");
  lines.push("- [Summary](#summary)");
  lines.push("- [Severity Breakdown](#severity-breakdown)");
  if (findings.length > 0) {
    lines.push("- [Findings](#findings)");
  }
  lines.push("- [Affected Files](#affected-files)");
  lines.push("");

  // ── Scan Information ────────────────────────────────────────────────

  lines.push("## Scan Information");
  lines.push("");
  lines.push("| Property | Value |");
  lines.push("|----------|-------|");
  lines.push(`| **Target** | \`${escapeMarkdown(meta.targetPath)}\` |`);
  lines.push(
    `| **Files Scanned** | ${meta.scannedFiles} of ${meta.totalFiles} |`,
  );
  lines.push(`| **Duration** | ${(meta.durationMs / 1000).toFixed(1)}s |`);
  lines.push(`| **Started** | ${meta.startedAt} |`);
  lines.push(`| **Completed** | ${meta.completedAt} |`);

  if (meta.provider) {
    lines.push(`| **AI Provider** | ${meta.provider} |`);
  }
  if (meta.model) {
    lines.push(`| **AI Model** | ${meta.model} |`);
  }
  if (meta.branch) {
    lines.push(`| **Git Branch** | \`${escapeMarkdown(meta.branch)}\` |`);
  }
  if (meta.commitHash) {
    lines.push(`| **Commit** | \`${escapeMarkdown(meta.commitHash)}\` |`);
  }

  lines.push("");

  // ── Summary ─────────────────────────────────────────────────────────

  lines.push("## Summary");
  lines.push("");

  if (findings.length === 0) {
    lines.push("\uf00c **No security issues found!** Your code looks clean.");
    lines.push("");
    lines.push(
      "> This doesn't guarantee your code is vulnerability-free — " +
        "consider manual review for logic flaws and business-specific risks.",
    );
  } else {
    const highestLabel = summary.highestSeverity
      ? getSeverityLabel(summary.highestSeverity)
      : "NONE";

    lines.push(
      `Found **${findings.length}** security issue${findings.length !== 1 ? "s" : ""}` +
        ` across **${summary.affectedFileCount}** file${summary.affectedFileCount !== 1 ? "s" : ""}**.`,
    );
    lines.push("");
    lines.push(
      `- **Highest Severity:** ${severityEmoji(summary.highestSeverity)} ${highestLabel}`,
    );
    lines.push(
      `- **Average Confidence:** ${Math.round(summary.averageConfidence * 100)}%`,
    );
    lines.push(
      `- **Categories:** ${summary.categories.map(formatCategoryLabel).join(", ")}`,
    );
  }

  lines.push("");

  // ── Severity Breakdown ──────────────────────────────────────────────

  lines.push("## Severity Breakdown");
  lines.push("");

  if (findings.length > 0) {
    lines.push("| Severity | Count | Indicator |");
    lines.push("|----------|------:|-----------|");

    for (const sev of SEVERITY_ORDER) {
      const count = summary.bySeverity[sev] ?? 0;
      if (count > 0) {
        const emoji = severityEmoji(sev);
        const label = getSeverityLabel(sev);
        const bar = "█".repeat(Math.min(count, 20));
        lines.push(`| ${emoji} **${label}** | ${count} | \`${bar}\` |`);
      }
    }

    lines.push("");

    // Category breakdown
    if (summary.categories.length > 0) {
      lines.push("### By Category");
      lines.push("");

      const catEntries = Object.entries(summary.byCategory).sort(
        ([, a], [, b]) => b - a,
      );

      lines.push("| Category | Count |");
      lines.push("|----------|------:|");

      for (const [cat, count] of catEntries) {
        lines.push(`| ${formatCategoryLabel(cat as any)} | ${count} |`);
      }

      lines.push("");
    }
  } else {
    lines.push("No findings to report.");
    lines.push("");
  }

  // ── Findings ────────────────────────────────────────────────────────

  if (findings.length > 0) {
    lines.push("## Findings");
    lines.push("");

    for (let i = 0; i < findings.length; i++) {
      const f = findings[i]!;
      lines.push(...formatMarkdownFinding(f, i + 1));
      lines.push("");
    }
  }

  // ── Affected Files ──────────────────────────────────────────────────

  if (summary.affectedFiles.length > 0) {
    lines.push("## Affected Files");
    lines.push("");
    for (const file of summary.affectedFiles) {
      lines.push(`- \`${escapeMarkdown(file)}\``);
    }
    lines.push("");
  }

  // ── Footer ──────────────────────────────────────────────────────────

  lines.push("---");
  lines.push("");
  lines.push(
    `*Generated by [${APP_NAME}](https://github.com/crack-code/crack-code) v${APP_VERSION} — ` +
      "This tool never modifies your source files. " +
      "All findings include severity, classification, remediation guidance, and ready-to-use AI prompts.*",
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * Format a single finding for Markdown output.
 */
function formatMarkdownFinding(finding: Finding, index: number): string[] {
  const lines: string[] = [];

  const emoji = severityEmoji(finding.severity);
  const sevLabel = getSeverityLabel(finding.severity);
  const catLabel = formatCategoryLabel(finding.category);

  lines.push(`### ${index}. ${emoji} ${finding.title}`);
  lines.push("");
  lines.push(`| Property | Value |`);
  lines.push(`|----------|-------|`);
  lines.push(`| **Severity** | ${emoji} ${sevLabel} |`);
  lines.push(`| **Category** | ${catLabel} |`);
  lines.push(`| **Confidence** | ${Math.round(finding.confidence * 100)}% |`);
  lines.push(`| **Source** | ${finding.source} |`);

  if (finding.cweIds.length > 0) {
    const cweLinks = finding.cweIds.map(
      (cwe) =>
        `[${cwe}](https://cwe.mitre.org/data/definitions/${cwe.replace("CWE-", "")}.html)`,
    );
    lines.push(`| **CWE** | ${cweLinks.join(", ")} |`);
  }

  if (finding.owaspCategory) {
    lines.push(`| **OWASP** | ${finding.owaspCategory} |`);
  }

  lines.push("");

  // Locations
  if (finding.locations.length > 0) {
    lines.push("**Affected Locations:**");
    lines.push("");
    for (const loc of finding.locations) {
      let locStr = `- \`${escapeMarkdown(loc.file)}\``;
      if (loc.startLine) {
        locStr += ` (line ${loc.startLine}`;
        if (loc.endLine && loc.endLine !== loc.startLine) {
          locStr += `–${loc.endLine}`;
        }
        locStr += ")";
      }
      lines.push(locStr);
    }
    lines.push("");
  }

  // Description
  lines.push("**Description:**");
  lines.push("");
  lines.push(finding.description);
  lines.push("");

  // Code snippets
  const snippetLocs = finding.locations.filter((l) => l.snippet);
  if (snippetLocs.length > 0) {
    for (const loc of snippetLocs) {
      const ext = loc.file.split(".").pop() || "";
      const lang = extensionToLanguage(ext);
      lines.push(
        `\`${escapeMarkdown(loc.file)}${loc.startLine ? `:${loc.startLine}` : ""}\``,
      );
      lines.push("");
      lines.push("```" + lang);
      lines.push(loc.snippet!);
      lines.push("```");
      lines.push("");
    }
  }

  // Remediation
  lines.push("**Remediation:**");
  lines.push("");
  lines.push(finding.remediation);
  lines.push("");

  // AI Prompt
  if (finding.aiPrompt) {
    lines.push("<details>");
    lines.push("<summary>\uf544 AI Fix Prompt (click to expand)</summary>");
    lines.push("");
    lines.push("```text");
    lines.push(finding.aiPrompt);
    lines.push("```");
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  // References
  if (finding.references.length > 0) {
    lines.push("**References:**");
    lines.push("");
    for (const ref of finding.references) {
      lines.push(`- ${ref}`);
    }
    lines.push("");
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// SARIF Report (v2.1.0)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a SARIF (Static Analysis Results Interchange Format) v2.1.0 report.
 *
 * SARIF is a standard format for static analysis tool output, supported by
 * GitHub Code Scanning, Azure DevOps, VS Code SARIF Viewer, and many other
 * tools in the CI/CD ecosystem.
 *
 * Reference: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 */
function generateSARIFReport(
  findings: Finding[],
  meta: ReportMeta,
  _summary: FindingsSummary,
  generatedAt: string,
): string {
  // Build the SARIF rule descriptors from findings
  const ruleMap = new Map<
    string,
    {
      id: string;
      name: string;
      shortDescription: string;
      fullDescription: string;
      helpUri?: string;
      properties: Record<string, unknown>;
    }
  >();

  for (const f of findings) {
    const ruleId = buildSARIFRuleId(f);
    if (!ruleMap.has(ruleId)) {
      ruleMap.set(ruleId, {
        id: ruleId,
        name: f.title.replace(/[^a-zA-Z0-9_-]/g, ""),
        shortDescription: f.title,
        fullDescription: f.description,
        helpUri: f.references[0],
        properties: {
          category: f.category,
          cweIds: f.cweIds,
          owaspCategory: f.owaspCategory ?? undefined,
        },
      });
    }
  }

  const rules = Array.from(ruleMap.values()).map((rule) => ({
    id: rule.id,
    name: rule.name,
    shortDescription: { text: rule.shortDescription },
    fullDescription: { text: rule.fullDescription },
    helpUri: rule.helpUri,
    properties: rule.properties,
    defaultConfiguration: {
      level: "warning" as const,
    },
  }));

  // Build SARIF results from findings
  const results = findings.map((f) => {
    const ruleId = buildSARIFRuleId(f);

    const locations = f.locations.map((loc) => ({
      physicalLocation: {
        artifactLocation: {
          uri: loc.file,
          uriBaseId: "%SRCROOT%",
        },
        region: loc.startLine
          ? {
              startLine: loc.startLine,
              endLine: loc.endLine ?? loc.startLine,
              startColumn: loc.column ?? undefined,
              snippet: loc.snippet ? { text: loc.snippet } : undefined,
            }
          : undefined,
      },
    }));

    return {
      ruleId,
      ruleIndex: Array.from(ruleMap.keys()).indexOf(ruleId),
      level: severityToSARIFLevel(f.severity),
      message: {
        text: f.description,
      },
      locations,
      fixes: f.remediation
        ? [
            {
              description: { text: f.remediation },
            },
          ]
        : undefined,
      properties: {
        severity: f.severity,
        category: f.category,
        confidence: f.confidence,
        source: f.source,
        aiPrompt: f.aiPrompt,
        cweIds: f.cweIds,
        owaspCategory: f.owaspCategory,
        remediation: f.remediation,
        findingId: f.id,
        createdAt: f.createdAt,
      },
    };
  });

  // Assemble the full SARIF log
  const sarifLog = {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0" as const,
    runs: [
      {
        tool: {
          driver: {
            name: APP_NAME,
            version: APP_VERSION,
            semanticVersion: APP_VERSION,
            informationUri: "https://github.com/crack-code/crack-code",
            rules,
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            startTimeUtc: meta.startedAt,
            endTimeUtc: meta.completedAt,
            properties: {
              targetPath: meta.targetPath,
              totalFiles: meta.totalFiles,
              scannedFiles: meta.scannedFiles,
              durationMs: meta.durationMs,
              provider: meta.provider,
              model: meta.model,
              branch: meta.branch,
              commitHash: meta.commitHash,
              sessionId: meta.sessionId,
              generatedAt,
            },
          },
        ],
        results,
        originalUriBaseIds: {
          "%SRCROOT%": {
            uri: normalizeUriPath(meta.targetPath),
          },
        },
      },
    ],
  };

  return JSON.stringify(sarifLog, null, 2) + "\n";
}

/**
 * Build a stable SARIF rule ID from a finding.
 *
 * Uses the category + a normalized hash of the title to produce
 * a deterministic, readable rule identifier.
 *
 * Example: "injection/sql-injection-in-user-input"
 */
function buildSARIFRuleId(finding: Finding): string {
  const category = finding.category;
  const normalized = finding.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

  return `${category}/${normalized}`;
}

/**
 * Map Crack Code severity levels to SARIF result levels.
 *
 * SARIF defines: "error" | "warning" | "note" | "none"
 */
function severityToSARIFLevel(
  severity: Severity,
): "error" | "warning" | "note" | "none" {
  switch (severity) {
    case SEVERITY.CRITICAL:
      return "error";
    case SEVERITY.HIGH:
      return "error";
    case SEVERITY.MEDIUM:
      return "warning";
    case SEVERITY.LOW:
      return "note";
    case SEVERITY.INFO:
      return "note";
    default:
      return "warning";
  }
}

/**
 * Normalize a file path to a URI-compatible path.
 *
 * On POSIX systems, prepends `file:///`.
 * On Windows, normalizes backslashes and prepends `file:///`.
 */
function normalizeUriPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    return `file://${normalized}/`;
  }
  // Windows-style absolute path (C:\...)
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${normalized}/`;
  }
  // Relative path — return as-is
  return normalized + "/";
}

// ── Markdown Helpers ────────────────────────────────────────────────────────

/**
 * Escape special Markdown characters in a string.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|])/g, "\\$1");
}

/**
 * Get an emoji for a severity level.
 */
function severityEmoji(severity: Severity | null): string {
  switch (severity) {
    case SEVERITY.CRITICAL:
      return "\uf06a"; //  nf-fa-exclamation_circle
    case SEVERITY.HIGH:
      return "\uf071"; //  nf-fa-warning
    case SEVERITY.MEDIUM:
      return "\uf05a"; //  nf-fa-info_circle
    case SEVERITY.LOW:
      return "\uf10c"; //  nf-fa-circle_o
    case SEVERITY.INFO:
      return "\uf05a"; //  nf-fa-info_circle
    default:
      return "\uf05a"; //  nf-fa-info_circle
  }
}

/**
 * Map a file extension to a Markdown code fence language hint.
 */
function extensionToLanguage(ext: string): string {
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    cs: "csharp",
    cpp: "cpp",
    c: "c",
    h: "c",
    hpp: "cpp",
    swift: "swift",
    php: "php",
    lua: "lua",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yaml: "yaml",
    yml: "yaml",
    json: "json",
    xml: "xml",
    html: "html",
    css: "css",
    scss: "scss",
    sql: "sql",
    dockerfile: "dockerfile",
    tf: "hcl",
    toml: "toml",
    ini: "ini",
    env: "bash",
    graphql: "graphql",
    gql: "graphql",
    proto: "protobuf",
    vue: "vue",
    svelte: "svelte",
    dart: "dart",
    r: "r",
    sol: "solidity",
    ex: "elixir",
    exs: "elixir",
    erl: "erlang",
    hs: "haskell",
    clj: "clojure",
    scala: "scala",
    pl: "perl",
    md: "markdown",
  };

  return map[ext.toLowerCase()] ?? "";
}

// ── Report Utilities ────────────────────────────────────────────────────────

/**
 * List all supported report formats with descriptions.
 */
export function listReportFormats(): Array<{
  value: ReportFormat;
  label: string;
  description: string;
}> {
  return [
    {
      value: "json",
      label: "JSON",
      description:
        "Machine-readable, full-fidelity JSON with all finding details and metadata.",
    },
    {
      value: "markdown",
      label: "Markdown",
      description:
        "Human-readable report with tables, code snippets, and collapsible AI prompts. Great for PRs.",
    },
    {
      value: "sarif",
      label: "SARIF (v2.1.0)",
      description:
        "Static Analysis Results Interchange Format. Compatible with GitHub Code Scanning, VS Code, and CI tools.",
    },
  ];
}

/**
 * Validate that a string is a recognized report format.
 */
export function isValidReportFormat(format: string): format is ReportFormat {
  return format === "json" || format === "markdown" || format === "sarif";
}

/**
 * Get the file extension for a report format.
 */
export function getReportExtension(format: ReportFormat): string {
  switch (format) {
    case "json":
      return ".json";
    case "markdown":
      return ".md";
    case "sarif":
      return ".sarif.json";
    default:
      return ".json";
  }
}

/**
 * Get the MIME type for a report format.
 */
export function getReportMimeType(format: ReportFormat): string {
  switch (format) {
    case "json":
      return "application/json";
    case "markdown":
      return "text/markdown";
    case "sarif":
      return "application/sarif+json";
    default:
      return "application/octet-stream";
  }
}
