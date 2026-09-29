import type { Capture } from "../schemas/capture.js";
import type { Findings, PayloadAssessment, RankedStrategy } from "../schemas/findings.js";
import type { Recommendation } from "../schemas/report.js";
import { redactJson, redactText, redactUrl } from "../utils/redact.js";
import { safeUrl, urlWithoutQuery } from "../utils/url.js";

const MAX_SUMMARY_CHARS = 40_000;

function data(a: PayloadAssessment | undefined, schemaChars: number) {
  if (!a) return undefined;
  return {
    records: a.recordSet
      ? { path: a.recordSet.path, count: a.recordSet.count, keys: a.recordSet.keys.slice(0, 15), signals: a.recordSet.signals }
      : null,
    visibleOverlap: Math.round(a.visibleOverlap * 100) / 100,
    paginationFields: a.paginationFields.slice(0, 8),
    schema: a.schema.slice(0, schemaChars),
  };
}

/** Types of GraphQL variables without their values. */
function variableShape(vars: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!vars) return undefined;
  return Object.fromEntries(
    Object.entries(vars).map(([k, v]) => [k, v === null ? "null" : Array.isArray(v) ? "array" : typeof v]),
  );
}

export interface SanitizedSummary {
  summary: Record<string, unknown>;
  /** Every source string Gemini is allowed to recommend. */
  observedSources: string[];
  /** Every observed request URL (redacted), for checking Gemini's text. */
  observedUrls: string[];
}

/**
 * Builds the only data that is ever sent to Gemini: findings metadata with
 * value-free schemas. No cookies, header values, tokens, bodies or page dumps.
 */
export function buildSanitizedSummary(
  capture: Capture,
  f: Findings,
  strategies: RankedStrategy[],
  recommendation: Recommendation,
  schemaChars = 600,
): SanitizedSummary {
  const observedSources = [...new Set(strategies.map((s) => s.source).filter((s): s is string => !!s))];
  const observedUrls = [...new Set(capture.requests.map((r) => redactUrl(r.url)))];

  const build = (chars: number) => ({
    target: redactUrl(capture.finalUrl),
    loggedInViaWindow: capture.usedLoginWindow,
    capture: {
      capturedRequests: capture.requests.length,
      jsonResponses: capture.requests.filter((r) => /json/i.test(r.contentType ?? "")).length,
      documentStatus: capture.document.status,
    },
    framework: f.framework.name,
    frameworksDetected: f.framework.detected.map((d) => d.name),
    rendering: f.rendering,
    candidateEndpoints: f.rest.slice(0, 8).map((c) => ({
      request: c.display,
      url: redactUrl(c.url),
      score: c.score,
      reasons: c.reasons,
      status: c.status,
      requestSentCookies: c.sentCookies,
      requestSentAuthorizationHeader: c.sentAuthorization,
      response: data(c.assessment, chars),
    })),
    graphql: f.graphql.slice(0, 5).map((op) => ({
      endpoint: redactUrl(op.endpoint),
      operationName: op.operationName,
      operationType: op.operationType,
      persistedQuery: !!op.persistedQueryHash,
      variableTypes: variableShape(op.variables),
      entityType: op.entityType,
      paginationFields: op.paginationFields,
      score: op.score,
      requestSentAuthorizationHeader: op.sentAuthorization,
      response: data(op.assessment, chars),
    })),
    nextjs: {
      detected: f.nextjs.detected,
      router: f.nextjs.router,
      signals: f.nextjs.signals,
      dataFetching: f.nextjs.dataFetching,
      nextData: f.nextjs.nextData
        ? { sizeBytes: f.nextjs.nextData.sizeBytes, pagePropsKeys: f.nextjs.nextData.pagePropsKeys, ...data(f.nextjs.nextData.assessment, chars) }
        : null,
      observedDataRequests: f.nextjs.dataRequests.map((d) => ({ url: redactUrl(d.url), ...data(d.assessment, chars) })),
      derivedDataUrlNotObserved: f.nextjs.derivedDataUrl ?? null,
      rscRequestCount: f.nextjs.rscRequests.length,
    },
    embeddedState: f.embeddedState.slice(0, 6).map((e) => ({
      name: e.name,
      kind: e.kind,
      locator: e.locator,
      sizeBytes: e.sizeBytes,
      parseable: e.parseable,
      jsonLdTypes: e.jsonLdTypes,
      canReplaceDom: e.canReplaceDom,
      score: e.score,
      ...data(e.assessment, chars),
    })),
    pagination: f.pagination.map((p) => ({ ...p, observedValues: undefined, observedValueCounts: Object.fromEntries(Object.entries(p.observedValues).map(([k, v]) => [k, v.length])) })),
    authentication: {
      mechanisms: f.auth.mechanisms,
      authRequired: f.auth.authRequired,
      browserNeededForLogin: f.auth.browserNeededForLogin,
      browserNeededAfterLogin: f.auth.browserNeededAfterLogin,
      sessionCookieCount: f.auth.sessionCookies.length,
      authorizationSchemes: f.auth.authorizationSchemes.map((s) => s.scheme),
      csrfHeaderNames: f.auth.csrfHeaders,
      apiKeyHeaderNames: f.auth.apiKeyHeaders,
      deniedResponses: f.auth.deniedResponses,
      loginRedirect: !!f.auth.loginRedirect,
      loginFormDetected: f.auth.loginFormDetected,
      botProtection: f.auth.botProtection,
      notes: f.auth.notes,
    },
    rankedStrategies: strategies.map((s) => ({ id: s.id, label: s.label, score: s.score, source: s.source, browserRequired: s.browserRequired, reasons: s.reasons })),
    deterministicRecommendation: { ...recommendation, generatedBy: undefined },
    observedSources,
  });

  let summary = build(schemaChars);
  let text = JSON.stringify(summary);
  for (const chars of [250, 80, 0]) {
    if (text.length <= MAX_SUMMARY_CHARS) break;
    summary = build(chars);
    text = JSON.stringify(summary);
  }
  // Defence in depth: key-based and pattern-based redaction over the final payload.
  const safe = JSON.parse(redactText(JSON.stringify(redactJson(summary)))) as Record<string, unknown>;
  return { summary: safe, observedSources, observedUrls };
}

/** Whether a source/URL string Gemini produced refers to something actually observed. */
export function isObservedReference(ref: string, observedSources: string[], observedUrls: string[]): boolean {
  const clean = ref.trim();
  if (observedSources.includes(clean)) return true;
  const url = /https?:\/\/\S+/.exec(clean)?.[0] ?? /^(?:[A-Z]+\s+)?(\/\S*)/.exec(clean)?.[1];
  if (!url) return false;
  const normalized = urlWithoutQuery(url.replace(/[)"'`,.;]+$/, ""));
  return observedUrls.some((u) => {
    const full = urlWithoutQuery(u);
    const path = safeUrl(u)?.pathname ?? "";
    return full === normalized || (normalized.startsWith("/") && path === normalized.split("?")[0]);
  }) || observedSources.some((s) => s.includes(url));
}
