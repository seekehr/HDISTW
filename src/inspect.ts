import { createGeminiClient, DEFAULT_GEMINI_MODEL, refineWithGemini, type GeminiClient } from "./ai/gemini.js";
import { buildSanitizedSummary } from "./ai/sanitize.js";
import { analyzeCapture } from "./analyzers/index.js";
import { generateExample } from "./codegen/index.js";
import type { Capture } from "./schemas/capture.js";
import type { Report } from "./schemas/report.js";
import { buildRecommendation, paginationFor } from "./scoring/recommendation.js";
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
  const strategies = rankStrategies(findings);
  const deterministic = buildRecommendation(capture, findings, strategies);

  let recommendation = deterministic;
  let ai: Report["ai"] = { used: false, note: opts.aiDisabledReason };
  if (opts.gemini) {
    const sanitized = buildSanitizedSummary(capture, findings, strategies, deterministic);
    const result = await refineWithGemini(opts.gemini, sanitized, strategies, deterministic);
    recommendation = result.recommendation;
    ai = { used: result.used, model: opts.gemini.model, note: result.note };
  }

  const chosen = strategies.find((s) => s.id === recommendation.strategy) ?? strategies[0];
  const codeExample = generateExample(
    recommendation.strategy,
    findings,
    capture.finalUrl,
    chosen ? paginationFor(findings, chosen) : undefined,
  );

  return {
    tool: "HowDoIScrapeThisWebsite",
    version: VERSION,
    target: capture.target,
    finalUrl: capture.finalUrl,
    generatedAt: new Date().toISOString(),
    interactive: capture.interactive,
    stats: {
      capturedRequests: capture.requests.length,
      ignoredRequests: capture.ignored.total,
      jsonResponses: capture.requests.filter((r) => /json/i.test(r.contentType ?? "")).length,
      interactionRequests: capture.requests.filter((r) => r.phase === "interaction").length,
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

export function geminiFromEnv(model?: string): { client?: GeminiClient; reason?: string } {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return { reason: "GEMINI_API_KEY not set; used the deterministic recommendation." };
  return { client: createGeminiClient(key, model || process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL) };
}
