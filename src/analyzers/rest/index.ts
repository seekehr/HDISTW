import type { CapturedRequest } from "../../schemas/capture.js";
import type { RestCandidate } from "../../schemas/findings.js";
import { isJsonContentType, jsonBody } from "../../utils/json.js";
import { displayRequest, endpointKey, safeUrl } from "../../utils/url.js";
import { clampScore, isNextDataRequest, sentAuthorization, sentCookies, type AnalysisContext } from "../context.js";
import { isGraphQLRequest } from "../graphql/index.js";
import { assessPayload } from "../payload.js";

const API_PATH = /\/(api|v\d+|rest|ajax|services?|data|search|query)(\/|$)|\.json$/i;
const CONFIG_LIKE =
  /(config|settings|flags?|features?|experiments?|translations?|i18n|locales?|manifest|consent|csrf|token|session|whoami|user\/me|\/me$|heartbeat|health|status|version)/i;

export const MIN_REST_SCORE = 25;

function scoreRequest(req: CapturedRequest, ctx: AnalysisContext) {
  const parsed = jsonBody(req);
  if (!parsed) return undefined;
  const assessment = assessPayload(parsed.value, ctx.visible);
  let score = assessment.score;
  const reasons: string[] = [];

  reasons.push(isJsonContentType(req.contentType) ? "JSON response" : "JSON body (non-JSON content type)");
  score += isJsonContentType(req.contentType) ? 15 : 10;
  if (req.resourceType === "fetch" || req.resourceType === "xhr") {
    score += 5;
    reasons.push("fetch/XHR request");
  }
  const path = safeUrl(req.url)?.pathname ?? "";
  if (API_PATH.test(path)) {
    score += 5;
    reasons.push("API-like path");
  }
  reasons.push(...assessment.reasons);
  if (!assessment.recordSet && CONFIG_LIKE.test(path)) {
    score -= 15;
    reasons.push("looks like configuration/session metadata, not page data");
  }
  if (req.status !== undefined && req.status >= 400) {
    score *= 0.3;
    reasons.push(`HTTP ${req.status} response`);
  }
  return { score: clampScore(score), reasons, assessment };
}

/** Ranks JSON responses (excluding GraphQL and Next.js data) as candidate REST data endpoints. */
export function analyzeRest(ctx: AnalysisContext): RestCandidate[] {
  const byKey = new Map<string, RestCandidate>();
  for (const req of ctx.capture.requests) {
    if (req.isNavigation || isGraphQLRequest(req) || isNextDataRequest(req)) continue;
    const scored = scoreRequest(req, ctx);
    if (!scored) continue;
    const key = endpointKey(req.method, req.url);
    const existing = byKey.get(key);
    const candidate: RestCandidate = {
      method: req.method,
      url: req.url,
      display: displayRequest(req.method, req.url, ctx.pageUrl),
      endpointKey: key,
      score: scored.score,
      reasons: scored.reasons,
      status: req.status,
      occurrences: (existing?.occurrences ?? 0) + 1,
      sentCookies: sentCookies(req) || (existing?.sentCookies ?? false),
      sentAuthorization: sentAuthorization(req) || (existing?.sentAuthorization ?? false),
      requestBody: req.postData,
      assessment: scored.assessment,
    };
    if (!existing || candidate.score > existing.score) byKey.set(key, candidate);
    else byKey.set(key, { ...existing, occurrences: candidate.occurrences });
  }
  return [...byKey.values()]
    .filter((c) => c.score >= MIN_REST_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);
}
