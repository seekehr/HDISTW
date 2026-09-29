import { clampScore } from "../analyzers/context.js";
import type { Findings, RankedStrategy, StrategyId } from "../schemas/findings.js";

export const STRATEGY_LABELS: Record<StrategyId, string> = {
  "rest-api": "Direct REST API",
  graphql: "GraphQL API",
  "nextjs-data": "Next.js data",
  "embedded-json": "Embedded JSON",
  "ssr-html": "HTML parsing",
  "playwright-dom": "Playwright DOM extraction",
  "browser-auth-http": "Browser login + direct HTTP",
};

/** Tie-break order: cheaper and more robust strategies first. */
const PREFERENCE: StrategyId[] = [
  "rest-api",
  "graphql",
  "nextjs-data",
  "embedded-json",
  "browser-auth-http",
  "ssr-html",
  "playwright-dom",
];

const AUTH_PENALTY = 25;

/**
 * Deterministic ranking of extraction strategies. Scores are 0..100 fitness
 * scores, not probabilities.
 */
export function rankStrategies(f: Findings): RankedStrategy[] {
  const out: RankedStrategy[] = [];
  const authGated = f.auth.authRequired !== "no";
  const authReason = "data requires an authenticated session";

  const bestRest = f.rest[0];
  if (bestRest) {
    const reasons = bestRest.reasons.slice(0, 5);
    let score = bestRest.score;
    if (bestRest.phase === "interaction") reasons.push("only requested after interaction; reproduce its parameters");
    if (authGated) {
      score -= AUTH_PENALTY;
      reasons.push(authReason);
    }
    out.push({ id: "rest-api", label: STRATEGY_LABELS["rest-api"], score, source: bestRest.display, browserRequired: "no", reasons });
  }

  const bestGql = f.graphql.find((op) => op.operationType !== "mutation");
  if (bestGql) {
    const reasons = bestGql.reasons.slice(0, 5);
    let score = bestGql.score;
    if (authGated) {
      score -= AUTH_PENALTY;
      reasons.push(authReason);
    }
    out.push({
      id: "graphql",
      label: STRATEGY_LABELS.graphql,
      score,
      source: `${bestGql.method} ${bestGql.endpoint} (${bestGql.operationName ?? "anonymous operation"})`,
      browserRequired: "no",
      reasons,
    });
  }

  const bestApi = [bestRest, bestGql].filter((s) => !!s).sort((a, b) => b.score - a.score)[0];
  if (authGated && bestApi) {
    const source = "display" in bestApi ? bestApi.display : `POST ${bestApi.endpoint} (${bestApi.operationName ?? "anonymous"})`;
    out.push({
      id: "browser-auth-http",
      label: STRATEGY_LABELS["browser-auth-http"],
      score: bestApi.score - 5,
      source,
      browserRequired: "login-only",
      reasons: ["log in once in a browser, then reuse the session for direct HTTP requests", ...bestApi.reasons.slice(0, 3)],
    });
  }

  const { nextjs } = f;
  if (nextjs.nextData || nextjs.dataRequests.length) {
    const reasons: string[] = [];
    let score = 0;
    let source = "__NEXT_DATA__ → props.pageProps";
    if (nextjs.nextData) {
      score = nextjs.nextData.assessment.score + 20;
      reasons.push("__NEXT_DATA__ JSON is served in the HTML (no JavaScript needed)", ...nextjs.nextData.assessment.reasons.slice(0, 3));
    }
    const bestData = [...nextjs.dataRequests].sort((a, b) => b.assessment.score - a.assessment.score)[0];
    if (bestData && bestData.assessment.score + 25 > score) {
      score = bestData.assessment.score + 25;
      source = `GET ${bestData.url}`;
      reasons.unshift("observed /_next/data JSON endpoint");
    }
    if (nextjs.buildId) reasons.push("build ID changes on every deploy");
    if (authGated) score -= 10;
    out.push({ id: "nextjs-data", label: STRATEGY_LABELS["nextjs-data"], score, source, browserRequired: "no", reasons });
  }

  const bestEmbedded = f.embeddedState.find((e) => e.parseable);
  if (bestEmbedded) {
    out.push({
      id: "embedded-json",
      label: STRATEGY_LABELS["embedded-json"],
      score: bestEmbedded.score - (authGated ? 10 : 0),
      source: bestEmbedded.locator,
      browserRequired: "no",
      reasons: bestEmbedded.reasons.slice(0, 5),
    });
  }

  const { rendering } = f;
  const coverage = rendering.initialHtmlCoverage;
  const isShell = rendering.initialWords < 15 || rendering.initialWords < rendering.renderedWords * 0.15 || coverage < 0.2;
  {
    let score = isShell ? Math.min(15, Math.round(coverage * 75)) : Math.round(30 + coverage * 50);
    const reasons = [`${Math.round(coverage * 100)}% of visible text is in the served HTML`];
    if (isShell) reasons.push("served HTML is mostly an empty shell");
    if (f.auth.loginRedirect) {
      score = Math.min(score, 20);
      reasons.push("served HTML is the login page, not the content");
    }
    if (f.pagination.some((p) => p.source === "html" && p.requestParams.length)) {
      score += 5;
      reasons.push("pagination links are plain URLs");
    }
    if (authGated) score -= 10;
    out.push({ id: "ssr-html", label: STRATEGY_LABELS["ssr-html"], score, source: "served HTML document", browserRequired: "no", reasons });
  }

  {
    const bestOther = Math.max(0, ...out.filter((s) => s.id !== "ssr-html").map((s) => s.score));
    const reasons: string[] = [];
    if (["client-rendered", "interaction-dependent"].includes(rendering.type))
      reasons.push(`page is ${rendering.type}; content appears only after JavaScript`);
    else if (coverage < 0.7) reasons.push(`${Math.round((1 - coverage) * 100)}% of visible text only appears after JavaScript`);
    if (f.auth.authRequired === "yes") reasons.push("page requires login; log in manually in the browser");
    if (bestOther < 50) reasons.push("no structured data source was found");
    else reasons.push("works as a fallback, but slower and more brittle than the sources above");
    // Without structured sources, a browser only wins decisively when the served HTML lacks the content.
    const byRendering = isShell || f.auth.loginRedirect ? 80 : 20 + 50 * (1 - coverage);
    out.push({
      id: "playwright-dom",
      label: STRATEGY_LABELS["playwright-dom"],
      score: Math.max(15, Math.min(byRendering, 80 - bestOther * 0.6)),
      source: "rendered DOM",
      browserRequired: "yes",
      reasons,
    });
  }

  return out
    .map((s) => ({ ...s, score: clampScore(s.score) }))
    .sort((a, b) => b.score - a.score || PREFERENCE.indexOf(a.id) - PREFERENCE.indexOf(b.id));
}
