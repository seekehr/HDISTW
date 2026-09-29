import type { NextjsFinding } from "../../schemas/findings.js";
import { byteSize, isPlainObject, jsonBody, parseJsonText } from "../../utils/json.js";
import { redactUrl } from "../../utils/redact.js";
import { safeUrl } from "../../utils/url.js";
import { isNextDataRequest, isRscRequest, type AnalysisContext } from "../context.js";
import { assessPayload } from "../payload.js";

const NEXT_DATA_SCRIPT = /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;

export function extractNextData(html: string): { raw: string; value: Record<string, unknown> } | undefined {
  const raw = NEXT_DATA_SCRIPT.exec(html)?.[1];
  if (!raw) return undefined;
  const parsed = parseJsonText(raw);
  return parsed && isPlainObject(parsed.value) ? { raw, value: parsed.value } : undefined;
}

/** The conventional `/_next/data/<buildId>/<path>.json` URL for a Pages Router page. */
export function nextDataUrl(pageUrl: string, buildId: string): string | undefined {
  const u = safeUrl(pageUrl);
  if (!u) return undefined;
  const path = u.pathname.replace(/\/$/, "") || "/index";
  return `${u.origin}/_next/data/${buildId}${path}.json${u.search}`;
}

export function analyzeNextjs(ctx: AnalysisContext): NextjsFinding {
  const { capture } = ctx;
  const html = capture.initialHtml || capture.renderedHtml;
  const signals: string[] = [];
  const dataFetching: string[] = [];

  const nextData = extractNextData(html);
  if (nextData) signals.push("__NEXT_DATA__ script");
  if (/\/_next\/static\//.test(html)) signals.push("/_next/static assets");
  const flightDataInHtml = /self\.__next_f\s*=|self\.__next_f\.push/.test(html);
  if (flightDataInHtml) signals.push("RSC flight data in HTML (self.__next_f)");
  if (/\/_next\/static\/chunks\/app\//.test(html)) signals.push("App Router chunks");
  const headerSources = [capture.document.headers, ...capture.requests.map((r) => r.responseHeaders)];
  if (headerSources.some((h) => /next\.js/i.test(h["x-powered-by"] ?? ""))) signals.push("x-powered-by: Next.js");
  if (headerSources.some((h) => Object.keys(h).some((k) => k.startsWith("x-nextjs-")))) signals.push("x-nextjs-* headers");

  const dataRequests = capture.requests
    .filter((r) => isNextDataRequest(r) && jsonBody(r))
    .map((r) => {
      const body = jsonBody(r)?.value;
      const pageProps = isPlainObject(body) && isPlainObject(body.pageProps) ? body.pageProps : body;
      return { url: r.url, status: r.status, assessment: assessPayload(pageProps, ctx.visible) };
    });
  if (dataRequests.length) signals.push(`${dataRequests.length} /_next/data request(s)`);

  const rscRequests = capture.requests.filter(isRscRequest).map((r) => ({ url: r.url }));
  if (rscRequests.length) signals.push(`${rscRequests.length} RSC request(s)`);

  const detected = signals.length > 0;
  let router: NextjsFinding["router"];
  if (detected) router = nextData ? "pages" : flightDataInHtml || rscRequests.length ? "app" : "unknown";

  let nextDataFinding: NextjsFinding["nextData"];
  let buildId: string | undefined;
  let page: string | undefined;
  let derivedDataUrl: string | undefined;
  if (nextData) {
    const v = nextData.value;
    buildId = typeof v.buildId === "string" ? v.buildId : undefined;
    page = typeof v.page === "string" ? v.page : undefined;
    if (v.gssp) dataFetching.push("getServerSideProps");
    if (v.gsp) dataFetching.push("getStaticProps");
    if (v.gip || v.appGip) dataFetching.push("getInitialProps");
    if (v.isFallback) dataFetching.push("fallback page");
    const props = isPlainObject(v.props) ? v.props : {};
    const pageProps = isPlainObject(props.pageProps) ? props.pageProps : props;
    nextDataFinding = {
      sizeBytes: byteSize(nextData.raw),
      pagePropsKeys: Object.keys(pageProps).slice(0, 20),
      assessment: assessPayload(pageProps, ctx.visible),
    };
    if (buildId && (v.gssp || v.gsp) && dataRequests.length === 0) {
      const derived = nextDataUrl(ctx.pageUrl, buildId);
      derivedDataUrl = derived ? redactUrl(derived) : undefined;
    }
  }
  if (flightDataInHtml || rscRequests.length) dataFetching.push("React Server Components");

  return {
    detected,
    router,
    signals,
    buildId,
    page,
    dataFetching,
    nextData: nextDataFinding,
    dataRequests,
    derivedDataUrl,
    rscRequests: rscRequests.slice(0, 10),
    flightDataInHtml,
  };
}
