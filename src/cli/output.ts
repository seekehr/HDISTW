import path from "node:path";
import { paginationFor, paginationLabel } from "../scoring/recommendation.js";
import type { Report } from "../schemas/report.js";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = paint(1);
export const dim = paint(2);
export const green = paint(32);
export const yellow = paint(33);
export const red = paint(31);
export const cyan = paint(36);

export const ok = (s: string) => `${green("✓")} ${s}`;
export const warn = (s: string) => `${yellow("!")} ${s}`;
export const fail = (s: string) => `${red("✗")} ${s}`;

const RECOMMENDED: Record<string, string> = {
  "rest-api": "Direct HTTP extraction (REST API)",
  graphql: "Direct HTTP extraction (GraphQL)",
  "nextjs-data": "Next.js data extraction (no browser)",
  "embedded-json": "Embedded JSON extraction (no browser)",
  "ssr-html": "HTML parsing (no browser)",
  "playwright-dom": "Playwright DOM extraction",
  "browser-auth-http": "Browser login, then direct HTTP",
};
const BROWSER = { no: "No", "login-only": "Only for login", yes: "Yes" } as const;

/** Concise terminal summary of a report. */
export function renderSummary(r: Report, markdownPath: string): string {
  const f = r.findings;
  const lines: string[] = [];
  const status = r.stats.documentStatus;
  if (status && status < 400) lines.push(ok(`Page loaded (${status}, ${(r.stats.durationMs / 1000).toFixed(1)}s)`));
  else lines.push(warn(`Page loaded with status ${status ?? "unknown"}`));

  if (f.framework.detected.length) lines.push(ok(`${f.framework.name} detected`));
  lines.push(ok(`Rendering: ${f.rendering.type}`));
  lines.push(ok(`${r.stats.jsonResponses} JSON responses found`));
  if (r.interactive) lines.push(ok(`${r.stats.interactionRequests} requests triggered by interaction`));

  const sources = f.rest.filter((c) => c.score >= 50).length + f.graphql.filter((g) => g.score >= 50).length +
    f.embeddedState.filter((e) => e.canReplaceDom).length + (f.nextjs.nextData?.assessment.recordSet ? 1 : 0);
  lines.push((sources ? ok : warn)(`${sources} candidate data source${sources === 1 ? "" : "s"}`));
  if (f.graphql.length) lines.push(ok(`${f.graphql.length} GraphQL operation${f.graphql.length === 1 ? "" : "s"}`));

  const top = r.strategies.find((s) => s.id === r.recommendation.strategy) ?? r.strategies[0];
  const pagination = top ? paginationFor(f, top) : undefined;
  if (pagination) lines.push(ok(`${paginationLabel(pagination)} pagination detected`));
  if (f.auth.authRequired !== "no") lines.push(warn(`Authentication ${f.auth.authRequired === "yes" ? "required" : "likely required"} (${f.auth.mechanisms.join(", ") || "login"})`));
  if (f.auth.botProtection.length) lines.push(warn(`Bot protection: ${f.auth.botProtection.join(", ")}`));
  if (r.ai.used) lines.push(ok(`Gemini analysis (${r.ai.model})`));
  else if (r.ai.note) lines.push(dim(`- ${r.ai.note}`));

  const rel = path.relative(process.cwd(), markdownPath);
  lines.push(
    "",
    bold("Best source:"),
    cyan(r.recommendation.source),
    "",
    bold("Recommended:"),
    RECOMMENDED[r.recommendation.strategy] ?? r.recommendation.strategy,
    "",
    bold("Browser required:"),
    BROWSER[r.recommendation.browserRequired],
    "",
    bold("Ranking:"),
    ...r.strategies.slice(0, 4).map((s, i) => `${i + 1}. ${s.label.padEnd(30)} ${String(s.score).padStart(3)}`),
    "",
    bold("Report:"),
    rel.startsWith("..") ? markdownPath : `./${rel.replace(/\\/g, "/")}`,
  );
  return lines.join("\n");
}
