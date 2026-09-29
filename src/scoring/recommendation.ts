import type { Capture } from "../schemas/capture.js";
import type { Findings, PaginationFinding, RankedStrategy } from "../schemas/findings.js";
import type { Recommendation } from "../schemas/report.js";

const PAGINATION_LABELS: Record<PaginationFinding["type"], string> = {
  cursor: "Cursor-based",
  token: "Token-based (opaque continuation token)",
  offset: "Offset-based",
  page: "Page-number-based",
  link: "Next-link-based",
  unknown: "Unclear",
};

export function paginationLabel(p: PaginationFinding): string {
  return PAGINATION_LABELS[p.type];
}

/** The pagination finding that belongs to the recommended source, if any. */
export function paginationFor(f: Findings, strategy: RankedStrategy): PaginationFinding | undefined {
  const bySource: Partial<Record<RankedStrategy["id"], PaginationFinding["source"]>> = {
    "rest-api": "rest",
    "browser-auth-http": "rest",
    graphql: "graphql",
    "nextjs-data": "nextjs",
    "embedded-json": "html",
    "ssr-html": "html",
    "playwright-dom": "html",
  };
  const source = bySource[strategy.id];
  const src = strategy.source ?? "";
  return (
    f.pagination.find((p) => src && (src === p.endpoint || src.startsWith(p.endpoint.split(" (")[0] ?? p.endpoint) || p.endpoint.startsWith(src))) ??
    f.pagination.find((p) => p.source === source) ??
    (strategy.id === "browser-auth-http" ? f.pagination.find((p) => p.source === "graphql") : undefined) ??
    (strategy.id === "nextjs-data" ? f.pagination.find((p) => p.source === "html") : undefined)
  );
}

export function describePagination(p: PaginationFinding | undefined): string {
  if (!p) return "No pagination detected for this source.";
  const parts = [`${paginationLabel(p)}.`];
  if (p.requestParams.length) parts.push(`Request: ${p.requestParams.map((x) => `\`${x}\``).join(", ")}.`);
  if (p.responseFields.length) parts.push(`Response: ${p.responseFields.map((x) => `\`${x}\``).join(", ")}.`);
  if (p.type === "cursor" || p.type === "token")
    parts.push("Pass the cursor/token from each response into the next request until it is empty.");
  if (p.type === "link") parts.push("Follow the next-page URL (from the response or the page's next link) until there is none.");
  if (p.type === "offset") parts.push("Increase the offset by the page size until fewer records come back.");
  if (p.type === "page") parts.push("Increment the page number until an empty page (or the total page count) is reached.");
  if (!p.confirmed) parts.push("(Inferred from names; not confirmed by multiple requests.)");
  return parts.join(" ");
}

export function collectUncertainties(capture: Capture, f: Findings, strategies: RankedStrategy[]): string[] {
  const out: string[] = [];
  const top = strategies[0];
  const topPagination = top ? paginationFor(f, top) : undefined;
  if (!topPagination)
    out.push("No pagination was observed for the recommended source. Only the page load is recorded, so requests made when scrolling or clicking 'next' are not seen.");
  if ((f.auth.authRequired === "yes" || f.auth.authRequired === "likely") && !capture.usedLoginWindow)
    out.push("The page seems to need a login. Run hdistw in a terminal so it can open a login window, or pass --login.");
  if (topPagination && !topPagination.confirmed)
    out.push("Pagination was inferred from parameter/field names, not confirmed by several requests.");
  if (f.nextjs.derivedDataUrl)
    out.push("The /_next/data URL is derived from the build ID, not observed. Build IDs change on every deploy.");
  if (top?.id === "rest-api" && f.rest[0]?.sentCookies)
    out.push("The best endpoint was requested with browser cookies; it is unverified whether it works without them.");
  if (f.graphql.some((op) => op.persistedQueryHash && !op.query))
    out.push("GraphQL uses persisted query hashes; the server may reject unknown or outdated hashes.");
  if (top?.id === "ssr-html" && f.rendering.initialHtmlCoverage < 0.7)
    out.push(
      `${Math.round((1 - f.rendering.initialHtmlCoverage) * 100)}% of the visible text only appears after JavaScript. If the data you need is in that part, use Playwright instead.`,
    );
  if (f.auth.botProtection.length)
    out.push(`Bot protection detected (${f.auth.botProtection.join(", ")}). Results may differ from a normal visit.`);
  if (capture.renderedText.trim().split(/\s+/).length < 20)
    out.push("Very little visible text was captured; the page may need a login, or it may have blocked the browser.");
  if (!f.rest.length && !f.graphql.length && !f.embeddedState.some((e) => e.parseable) && !f.nextjs.nextData)
    out.push("No structured data source (API, GraphQL, embedded JSON) was observed.");
  for (const e of capture.errors) out.push(`Capture: ${e}`);
  return out;
}

function why(f: Findings, top: RankedStrategy): string {
  switch (top.id) {
    case "rest-api": {
      const c = f.rest[0];
      const rs = c?.assessment.recordSet;
      const base = rs
        ? `The endpoint returns ${rs.count} structured records (${rs.path || "root"})`
        : "The endpoint returns structured JSON";
      const overlap = c && c.assessment.visibleOverlap >= 0.4 ? " that match the content shown on the page" : "";
      return `${base}${overlap}.`;
    }
    case "graphql":
      return `The page loads its data through a GraphQL operation that returns structured JSON${
        f.graphql[0]?.entityType ? ` (${f.graphql[0].entityType})` : ""
      }.`;
    case "nextjs-data":
      return "The page data is already serialized by Next.js as JSON, so no rendering or DOM parsing is needed.";
    case "embedded-json":
      return "The served HTML contains the page data as structured JSON, which is more stable than DOM selectors.";
    case "browser-auth-http":
      return "The data comes from an API that requires a logged-in session. A browser is only needed to log in; the API can then be called directly.";
    case "ssr-html":
      return "The content is present in the HTML sent by the server, so a plain HTTP request plus an HTML parser is enough.";
    case "playwright-dom":
      return "No cheaper structured source carried the page data; the content only exists after JavaScript runs.";
  }
}

function statePreserve(f: Findings, top: RankedStrategy): string[] {
  const out: string[] = [];
  const api = top.id === "graphql" ? f.graphql[0] : f.rest[0];
  if (top.id === "browser-auth-http") out.push("Session cookies or bearer token from the logged-in browser");
  if (api && ["rest-api", "graphql", "browser-auth-http"].includes(top.id)) {
    if (api.sentAuthorization) out.push("Authorization header (token scheme observed; value redacted)");
    if (api.sentCookies && top.id !== "browser-auth-http") out.push("Cookies, if plain requests are rejected");
  }
  if (f.auth.csrfHeaders.length) out.push(`CSRF header(s): ${f.auth.csrfHeaders.join(", ")}`);
  if (top.id === "nextjs-data" && f.nextjs.buildId) out.push("Current Next.js build ID (re-read it from the HTML after deploys)");
  if (top.id === "graphql" && f.graphql[0]?.persistedQueryHash) out.push("Persisted query hash (sha256Hash)");
  return out.length ? out : ["None detected"];
}

function avoid(f: Findings, top: RankedStrategy): string[] {
  const out: string[] = [];
  if (["rest-api", "graphql", "nextjs-data", "embedded-json", "browser-auth-http"].includes(top.id)) {
    out.push("DOM scraping: the same data is available as structured JSON.");
    out.push("Running a browser for every page: it is only useful for discovery" + (top.id === "browser-auth-http" ? " and login." : "."));
  }
  if (top.id === "ssr-html") out.push("A headless browser: the content is already in the served HTML.");
  if (top.id === "playwright-dom") out.push("Guessing undocumented endpoints: none of the observed requests carried the page data.");
  if (f.auth.botProtection.length) out.push("Trying to bypass bot protection or CAPTCHAs.");
  out.push("High request rates: throttle requests and respect robots.txt and the site's terms.");
  return out;
}

/** Deterministic recommendation from the top-ranked strategy. Gemini may refine it. */
export function buildRecommendation(capture: Capture, f: Findings, strategies: RankedStrategy[]): Recommendation {
  const top = strategies[0];
  if (!top) throw new Error("No strategies ranked");
  return {
    strategy: top.id,
    source: top.source ?? capture.finalUrl,
    why: why(f, top),
    browserRequired: top.browserRequired,
    browserOnlyForAuth: top.browserRequired === "login-only",
    pagination: describePagination(paginationFor(f, top)),
    statePreserve: statePreserve(f, top),
    avoid: avoid(f, top),
    uncertainties: collectUncertainties(capture, f, strategies),
    generatedBy: "deterministic",
  };
}

/** Used when the captured page was a bot check: no strategy, just what to do next. */
export function blockedRecommendation(capture: Capture, reason: string): Recommendation {
  return {
    strategy: null,
    source: "none observed",
    why: `${reason} The real page was never loaded, so there is no recommendation.`,
    browserRequired: "yes",
    browserOnlyForAuth: false,
    pagination: "Unknown: the page was not observed.",
    statePreserve: [],
    avoid: ["Trying to bypass the bot check. hdistw will not do this, and it usually breaks the site's terms."],
    uncertainties: [
      capture.usedLoginWindow
        ? "The page still showed a bot check after the login window. Try again, or check the site in your normal browser."
        : "Run hdistw in a terminal so it can open a browser window where you pass the check yourself, or pass --login.",
      ...capture.errors.map((e) => `Capture: ${e}`),
    ],
    generatedBy: "deterministic",
  };
}
