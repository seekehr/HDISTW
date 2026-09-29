import type { CapturedRequest } from "../../schemas/capture.js";
import type { GraphQLOperation } from "../../schemas/findings.js";
import { isPlainObject, jsonBody, parseJsonText } from "../../utils/json.js";
import { redactJson } from "../../utils/redact.js";
import { safeUrl, urlWithoutQuery } from "../../utils/url.js";
import { clampScore, sentAuthorization, sentCookies, type AnalysisContext } from "../context.js";
import { assessPayload } from "../payload.js";
import { findPaginationFields, paramKind, STRONG_RESPONSE_KINDS } from "../pagination/vocabulary.js";

const QUERY_TEXT = /^\s*(query|mutation|subscription|fragment|\{)/;

interface RawOperation {
  query?: string;
  operationName?: string;
  variables?: Record<string, unknown>;
  persistedQueryHash?: string;
}

function toOperation(value: unknown): RawOperation | undefined {
  if (!isPlainObject(value)) return undefined;
  const query = typeof value.query === "string" ? value.query : undefined;
  const ext = isPlainObject(value.extensions) ? value.extensions : undefined;
  const persisted = ext && isPlainObject(ext.persistedQuery) ? ext.persistedQuery : undefined;
  const hash = typeof persisted?.sha256Hash === "string" ? persisted.sha256Hash : undefined;
  const operationName = typeof value.operationName === "string" ? value.operationName : undefined;
  if (!(query && QUERY_TEXT.test(query)) && !hash && !operationName) return undefined;
  const variables = isPlainObject(value.variables) ? value.variables : undefined;
  return { query, operationName, variables, persistedQueryHash: hash };
}

/** Extracts GraphQL operations from a request (POST JSON body, batched arrays, or GET params). */
export function graphqlOperations(req: CapturedRequest): RawOperation[] {
  if (req.postData) {
    const parsed = parseJsonText(req.postData);
    if (parsed) {
      const items = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
      const ops = items.map(toOperation).filter((o): o is RawOperation => !!o);
      if (ops.length) return ops;
    }
    if (/^\s*(query|mutation)\b/.test(req.postData) && /graphql/i.test(req.contentType ?? req.requestHeaders["content-type"] ?? "")) {
      return [{ query: req.postData }];
    }
  }
  const url = safeUrl(req.url);
  if (url && req.method === "GET") {
    const params = url.searchParams;
    const tryJson = (key: string) => {
      const raw = params.get(key);
      return raw ? parseJsonText(raw)?.value : undefined;
    };
    const op = toOperation({
      query: params.get("query") ?? undefined,
      operationName: params.get("operationName") ?? undefined,
      variables: tryJson("variables"),
      extensions: tryJson("extensions"),
    });
    if (op && (op.query || op.persistedQueryHash || /graphql|gql/i.test(url.pathname))) return [op];
  }
  return [];
}

export function isGraphQLRequest(req: CapturedRequest): boolean {
  if (graphqlOperations(req).length) return true;
  const path = safeUrl(req.url)?.pathname ?? "";
  if (!/\/(graphql|gql)(\/|$)/i.test(path)) return false;
  const body = jsonBody(req)?.value;
  return isPlainObject(body) && ("data" in body || "errors" in body);
}

function operationType(query?: string): GraphQLOperation["operationType"] {
  if (!query) return "unknown";
  const m = /^\s*(query|mutation|subscription)\b/.exec(query);
  if (m) return m[1] as GraphQLOperation["operationType"];
  return query.trim().startsWith("{") ? "query" : "unknown";
}

function entityType(data: unknown, recordPath?: string): string | undefined {
  if (recordPath) {
    const segments = recordPath.split(".").map((s) => s.replace("[]", "")).filter((s) => s && s !== "data" && s !== "node" && s !== "edges" && s !== "*");
    if (segments.length) return segments[segments.length - 1];
  }
  if (isPlainObject(data) && isPlainObject(data.data)) return Object.keys(data.data)[0];
  return undefined;
}

function typename(value: unknown, path?: string): string | undefined {
  // Look for __typename on the first record.
  let cur: unknown = value;
  for (const part of (path ?? "").split(".").filter(Boolean)) {
    const key = part.replace("[]", "");
    if (key && isPlainObject(cur)) cur = cur[key];
    if (part.endsWith("[]") && Array.isArray(cur)) cur = cur[0];
  }
  return isPlainObject(cur) && typeof cur.__typename === "string" ? cur.__typename : undefined;
}

export function analyzeGraphQL(ctx: AnalysisContext): GraphQLOperation[] {
  const byKey = new Map<string, GraphQLOperation>();
  for (const req of ctx.capture.requests) {
    if (!isGraphQLRequest(req)) continue;
    const ops = graphqlOperations(req);
    const body = jsonBody(req)?.value;
    const responses = Array.isArray(body) ? body : [body];
    const list: RawOperation[] = ops.length ? ops : [{}];

    list.forEach((op, i) => {
      const response = responses[i] ?? responses[0];
      const assessment = assessPayload(response, ctx.visible);
      const type = operationType(op.query);
      const reasons = ["GraphQL operation", ...assessment.reasons];
      let score = assessment.score + 20;
      if (type === "mutation") {
        score -= 30;
        reasons.push("mutation (changes data; not a read source)");
      }
      if (op.persistedQueryHash && !op.query) {
        score -= 5;
        reasons.push("persisted query (hash may change between deploys)");
      }
      const hasErrors = isPlainObject(response) && Array.isArray(response.errors) && response.errors.length > 0;
      const hasData = isPlainObject(response) && response.data != null;
      if ((hasErrors && !hasData) || (req.status ?? 200) >= 400) {
        score *= 0.3;
        reasons.push(hasErrors ? "response contains errors" : `HTTP ${req.status}`);
      }

      const variableKeys = Object.keys(op.variables ?? {});
      const varPagination = variableKeys.filter((k) => paramKind(k)).map((k) => `variables.${k}`);
      const respPagination = findPaginationFields(response)
        .filter((f) => STRONG_RESPONSE_KINDS.has(f.kind))
        .map((f) => f.path);

      const endpoint = urlWithoutQuery(req.url);
      const opKey = op.operationName ?? op.persistedQueryHash ?? op.query?.slice(0, 80) ?? "anonymous";
      const key = `${endpoint} ${opKey}`;
      const existing = byKey.get(key);
      const candidate: GraphQLOperation = {
        endpoint,
        method: req.method,
        operationName: op.operationName ?? /^\s*(?:query|mutation|subscription)\s+(\w+)/.exec(op.query ?? "")?.[1],
        operationType: type,
        query: op.query?.slice(0, 6000),
        persistedQueryHash: op.persistedQueryHash,
        variables: op.variables ? (redactJson(op.variables) as Record<string, unknown>) : undefined,
        entityType: typename(response, assessment.recordSet?.path) ?? entityType(response, assessment.recordSet?.path),
        paginationFields: [...varPagination, ...respPagination],
        phase: existing?.phase === "initial" ? "initial" : req.phase,
        status: req.status,
        occurrences: (existing?.occurrences ?? 0) + 1,
        sentCookies: sentCookies(req),
        sentAuthorization: sentAuthorization(req),
        score: clampScore(score),
        reasons,
        assessment,
      };
      if (!existing || candidate.score > existing.score) byKey.set(key, candidate);
      else byKey.set(key, { ...existing, occurrences: candidate.occurrences, phase: candidate.phase });
    });
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, 15);
}
