import { createGeminiClient, DEFAULT_GEMINI_MODEL, refineWithGemini, type GeminiClient } from "./ai/gemini.js";
import { buildSanitizedSummary } from "./ai/sanitize.js";
import { analyzeCapture } from "./analyzers/index.js";
import { generateExample } from "./codegen/index.js";
import type { Capture } from "./schemas/capture.js";
import type { Report } from "./schemas/report.js";
import { challengeSignals, isBlockedPage } from "./analyzers/blocking.js";
import { blockedRecommendation, buildRecommendation, paginationFor } from "./scoring/recommendation.js";
import { rankStrategies } from "./scoring/strategies.js";

export const VERSION = "0.1.0";

export interface BuildReportOptions {
  /** Gemini client; when absent the deterministic recommendation is used. */
  gemini?: GeminiClient;
  aiDisabledReason?: string;
}

/** Everything after capture: analysis, ranking, optional Gemini, codegen. */
export async function buildReport(capture: Capture, opts: BuildReportOptions = {}): Promise<Report> {
  const findings = analyzeCapture(capture);
  const signals = { status: capture.document.status, title: capture.dom.title, text: capture.renderedText, headers: capture.document.headers };
  const blocked = isBlockedPage(signals);
  // Never rank strategies for a bot-check page: every conclusion would be about the challenge, not the site.
  const strategies = blocked ? [] : rankStrategies(findings);
  const blockedReason = blocked
    ? `The site served a bot check (${challengeSignals(signals).join(", ")}${capture.document.status ? `, HTTP ${capture.document.status}` : ""}) instead of the page.`
    : undefined;
  const deterministic = blocked
    ? blockedRecommendation(capture, blockedReason as string)
    : buildRecommendation(capture, findings, strategies);

  let recommendation = deterministic;
  let ai: Report["ai"] = { used: false, note: blocked ? "Skipped: nothing to analyze." : opts.aiDisabledReason };
  if (opts.gemini && !blocked) {
    const sanitized = buildSanitizedSummary(capture, findings, strategies, deterministic);
    const result = await refineWithGemini(opts.gemini, sanitized, strategies, deterministic);
    recommendation = result.recommendation;
    ai = { used: result.used, model: opts.gemini.model, note: result.note };
  }

  const chosen = strategies.find((s) => s.id === recommendation.strategy) ?? strategies[0];
  const codeExample = recommendation.strategy
    ? generateExample(recommendation.strategy, findings, capture.finalUrl, chosen ? paginationFor(findings, chosen) : undefined)
    : "";

  return {
    tool: "HowDoIScrapeThisWebsite",
    version: VERSION,
    target: capture.target,
    finalUrl: capture.finalUrl,
    generatedAt: new Date().toISOString(),
    usedLoginWindow: capture.usedLoginWindow,
    outcome: blocked ? "blocked" : "analyzed",
    blockedReason,
    stats: {
      capturedRequests: capture.requests.length,
      ignoredRequests: capture.ignored.total,
      jsonResponses: capture.requests.filter((r) => /json/i.test(r.contentType ?? "")).length,
      documentStatus: capture.document.status,
      durationMs: capture.durationMs,
    },
    findings,
    strategies,
    recommendation,
    ai,
    codeExample,
    uncertainties: recommendation.uncertainties,
    errors: capture.errors,
  };
}

/**
 * Why the user should log in (or pass a bot check) in a visible window before
 * this page can be analyzed. Undefined when the headless capture looks fine.
 */
export function loginReason(capture: Capture): string | undefined {
  const signals = { status: capture.document.status, title: capture.dom.title, text: capture.renderedText, headers: capture.document.headers };
  if (isBlockedPage(signals)) return "The site showed a bot check.";
  const { auth } = analyzeCapture(capture);
  if (auth.loginRedirect) return "The page redirected to a login page.";
  if (auth.authRequired === "yes" || auth.authRequired === "likely") return "The page looks like it needs a login.";
  return undefined;
}

export function geminiFromEnv(model?: string): { client?: GeminiClient; reason?: string } {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return { reason: "GEMINI_API_KEY not set; used the deterministic recommendation." };
  return { client: createGeminiClient(key, model || process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL) };
}
