import type { CapturedRequest } from "../../schemas/capture.js";
import type {
  GraphQLOperation,
  NextjsFinding,
  PaginationFinding,
  PaginationType,
  RestCandidate,
} from "../../schemas/findings.js";
import { isPlainObject, jsonBody, parseJsonText } from "../../utils/json.js";
import { endpointKey, safeUrl, shortUrl, urlWithoutQuery } from "../../utils/url.js";
import type { AnalysisContext } from "../context.js";
import { graphqlOperations } from "../graphql/index.js";
import {
  findPaginationFields,
  paramKind,
  responseKind,
  STRONG_RESPONSE_KINDS,
  type ParamKind,
  type ResponseFieldKind,
} from "./vocabulary.js";

/** Request parameters from the query string and JSON body (top level, `variables`, one nested level). */
export function requestParams(req: CapturedRequest): Record<string, string> {
  const out: Record<string, string> = {};
  const u = safeUrl(req.url);
  u?.searchParams.forEach((v, k) => (out[k] = v));
  const body = req.postData ? parseJsonText(req.postData)?.value : undefined;
  const addObject = (obj: unknown, depth: number) => {
    if (!isPlainObject(obj) || depth > 2) return;
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || typeof v !== "object") out[k] = String(v);
      else addObject(v, depth + 1);
    }
  };
  addObject(body, 0);
  if (req.postData && !body) new URLSearchParams(req.postData).forEach((v, k) => (out[k] = v));
  return out;
}

function classify(params: ParamKind[], fields: ResponseFieldKind[], fieldPaths: string[]): PaginationType | undefined {
  const has = (k: ParamKind | ResponseFieldKind) =>
    (params as string[]).includes(k) || (fields as string[]).includes(k);
  if (params.includes("cursor") || fields.includes("cursor") || fieldPaths.some((p) => /pageInfo\.(endCursor|hasNextPage)/i.test(p)))
    return "cursor";
  if (has("token")) return "token";
  if (params.includes("offset")) return "offset";
  if (params.includes("page") || fields.includes("page")) return "page";
  if (fields.includes("offset")) return "offset";
  if (fields.includes("next-link")) return "link";
  if (fields.includes("has-more") || params.includes("limit")) return "unknown";
  return undefined;
}

interface Group {
  endpoint: string;
  source: PaginationFinding["source"];
  requests: CapturedRequest[];
  params: (req: CapturedRequest) => Record<string, string>;
  responseOf: (req: CapturedRequest) => unknown;
}

function analyzeGroup(group: Group): PaginationFinding | undefined {
  const observed: Record<string, Set<string>> = {};
  const paramKinds = new Set<ParamKind>();
  for (const req of group.requests) {
    for (const [name, value] of Object.entries(group.params(req))) {
      const kind = paramKind(name);
      if (!kind) continue;
      paramKinds.add(kind);
      (observed[name] ??= new Set()).add(value);
    }
  }
  const fields = new Map<string, ResponseFieldKind>();
  for (const req of group.requests) {
    for (const f of findPaginationFields(group.responseOf(req))) fields.set(f.path, f.kind);
  }
  const strongFields = [...fields.entries()].filter(([, k]) => STRONG_RESPONSE_KINDS.has(k));
  // A lone `limit`/`size` param is not pagination evidence on its own.
  const onlyLimit = [...paramKinds].every((k) => k === "limit") && strongFields.length === 0;
  if ((paramKinds.size === 0 && strongFields.length === 0) || onlyLimit) return undefined;

  const type = classify([...paramKinds], [...fields.values()], [...fields.keys()]);
  if (!type) return undefined;

  const evidence: string[] = [];
  const requestParamNames = Object.keys(observed);
  if (requestParamNames.length) evidence.push(`request parameters: ${requestParamNames.join(", ")}`);
  if (strongFields.length) evidence.push(`response fields: ${strongFields.map(([p]) => p).join(", ")}`);
  const varying = Object.entries(observed).filter(([name, values]) => values.size > 1 && paramKind(name) !== "limit");
  for (const [name, values] of varying) evidence.push(`${values.size} requests with different \`${name}\` values`);
  const interactionCount = group.requests.filter((r) => r.phase === "interaction").length;
  if (interactionCount) evidence.push(`${interactionCount} request(s) triggered by interaction`);

  return {
    endpoint: group.endpoint,
    source: group.source,
    type,
    requestParams: requestParamNames,
    responseFields: strongFields.map(([p]) => p),
    observedValues: Object.fromEntries(Object.entries(observed).map(([k, v]) => [k, [...v].slice(0, 10)])),
    confirmed: varying.length > 0,
    evidence,
  };
}

function htmlPagination(ctx: AnalysisContext): PaginationFinding | undefined {
  const { paginationLinks, hasLoadMoreButton } = ctx.capture.dom;
  if (!paginationLinks.length && !hasLoadMoreButton) return undefined;
  const params = new Set<string>();
  let pathStyle = false;
  for (const link of paginationLinks) {
    const u = safeUrl(link);
    u?.searchParams.forEach((_v, k) => paramKind(k) && params.add(k));
    if (u && /\/page[-/]\d+/.test(u.pathname)) pathStyle = true;
  }
  const kinds = [...params].map((p) => paramKind(p));
  const evidence: string[] = [];
  if (paginationLinks.length) evidence.push(`${paginationLinks.length} pagination link(s) in the DOM`);
  if (pathStyle) evidence.push("path-based page numbers (/page/N or page-N)");
  if (hasLoadMoreButton)
    evidence.push(`load-more button (probably triggers an API request${ctx.capture.interactive ? "" : "; try --interactive"})`);
  return {
    endpoint: shortUrl(urlWithoutQuery(ctx.pageUrl), ctx.pageUrl),
    source: "html",
    type: kinds.includes("offset") ? "offset" : params.size || pathStyle ? "page" : paginationLinks.length ? "link" : "unknown",
    requestParams: [...params],
    responseFields: [],
    observedValues: {},
    confirmed: paginationLinks.length > 1,
    evidence,
  };
}

export function analyzePagination(
  ctx: AnalysisContext,
  rest: RestCandidate[],
  graphql: GraphQLOperation[],
  nextjs: NextjsFinding,
): PaginationFinding[] {
  const { requests } = ctx.capture;
  const findings: PaginationFinding[] = [];

  for (const candidate of rest) {
    const group = requests.filter((r) => endpointKey(r.method, r.url) === candidate.endpointKey);
    const f = analyzeGroup({
      endpoint: candidate.display,
      source: "rest",
      requests: group,
      params: requestParams,
      responseOf: (r) => jsonBody(r)?.value,
    });
    if (f) findings.push(f);
  }

  for (const op of graphql) {
    if (op.operationType === "mutation") continue;
    const matches = (r: CapturedRequest) =>
      urlWithoutQuery(r.url) === op.endpoint &&
      graphqlOperations(r).some((o) => (o.operationName ?? o.persistedQueryHash) === (op.operationName ?? op.persistedQueryHash));
    const f = analyzeGroup({
      endpoint: `${shortUrl(op.endpoint, ctx.pageUrl)} (${op.operationName ?? "anonymous"})`,
      source: "graphql",
      requests: requests.filter(matches),
      params: (r) => {
        const out: Record<string, string> = {};
        for (const o of graphqlOperations(r)) {
          for (const [k, v] of Object.entries(o.variables ?? {})) if (v === null || typeof v !== "object") out[k] = String(v);
        }
        return out;
      },
      responseOf: (r) => jsonBody(r)?.value,
    });
    if (f) findings.push(f);
  }

  if (nextjs.nextData) {
    const strong = nextjs.nextData.assessment.paginationFields.filter((p) => {
      const kind = responseKind(p.split(".").pop() ?? "");
      return kind && STRONG_RESPONSE_KINDS.has(kind);
    });
    if (strong.length) {
      const kinds = strong.map((p) => responseKind(p.split(".").pop() ?? "")).filter((k): k is ResponseFieldKind => !!k);
      findings.push({
        endpoint: "__NEXT_DATA__ pageProps",
        source: "nextjs",
        type: classify([], kinds, strong) ?? "unknown",
        requestParams: [],
        responseFields: strong.map((p) => `props.pageProps.${p}`),
        observedValues: {},
        confirmed: false,
        evidence: [`pageProps fields: ${strong.join(", ")}`],
      });
    }
  }

  const html = htmlPagination(ctx);
  // A bare load-more button adds nothing once the request behind it has been found.
  if (html && (html.type !== "unknown" || findings.length === 0)) findings.push(html);
  return findings;
}
