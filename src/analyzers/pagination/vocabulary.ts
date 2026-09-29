import { isPlainObject } from "../../utils/json.js";

export type ParamKind = "page" | "offset" | "limit" | "cursor" | "token";
export type ResponseFieldKind =
  | "cursor"
  | "token"
  | "page"
  | "offset"
  | "limit"
  | "has-more"
  | "total"
  | "next-link"
  | "page-info";

const norm = (key: string) => key.toLowerCase().replace(/[-_]/g, "");

const PARAM_KINDS: Record<string, ParamKind> = {
  page: "page",
  p: "page",
  pg: "page",
  pagenumber: "page",
  pageno: "page",
  pagenum: "page",
  pageindex: "page",
  currentpage: "page",
  offset: "offset",
  skip: "offset",
  start: "offset",
  from: "offset",
  startindex: "offset",
  limit: "limit",
  perpage: "limit",
  pagesize: "limit",
  size: "limit",
  count: "limit",
  first: "limit",
  last: "limit",
  take: "limit",
  rows: "limit",
  hitsperpage: "limit",
  maxresults: "limit",
  cursor: "cursor",
  after: "cursor",
  before: "cursor",
  startcursor: "cursor",
  endcursor: "cursor",
  sinceid: "cursor",
  maxid: "cursor",
  nextcursor: "cursor",
  nexttoken: "token",
  pagetoken: "token",
  nextpagetoken: "token",
  continuationtoken: "token",
  continuation: "token",
  scrollid: "token",
  lastevaluatedkey: "token",
  exclusivestartkey: "token",
};

const RESPONSE_KINDS: Record<string, ResponseFieldKind> = {
  nextcursor: "cursor",
  cursor: "cursor",
  endcursor: "cursor",
  startcursor: "cursor",
  prevcursor: "cursor",
  aftercursor: "cursor",
  nexttoken: "token",
  nextpagetoken: "token",
  continuationtoken: "token",
  continuation: "token",
  lastevaluatedkey: "token",
  scrollid: "token",
  nextpage: "page",
  page: "page",
  currentpage: "page",
  pagenumber: "page",
  totalpages: "page",
  pagecount: "page",
  lastpage: "page",
  offset: "offset",
  skip: "offset",
  limit: "limit",
  perpage: "limit",
  pagesize: "limit",
  hasmore: "has-more",
  hasnextpage: "has-more",
  haspreviouspage: "has-more",
  hasnext: "has-more",
  morelink: "has-more",
  islastpage: "has-more",
  total: "total",
  totalcount: "total",
  totalresults: "total",
  totalitems: "total",
  count: "total",
  next: "next-link",
  nexturl: "next-link",
  nextlink: "next-link",
  nextpageurl: "next-link",
  pageinfo: "page-info",
};

/** Kinds that on their own suggest pagination (unlike `total`/`limit`). */
export const STRONG_RESPONSE_KINDS = new Set<ResponseFieldKind>([
  "cursor",
  "token",
  "page",
  "offset",
  "has-more",
  "next-link",
  "page-info",
]);

export function paramKind(name: string): ParamKind | undefined {
  return PARAM_KINDS[norm(name)];
}

export function responseKind(name: string): ResponseFieldKind | undefined {
  return RESPONSE_KINDS[norm(name)];
}

export interface ResponseField {
  path: string;
  kind: ResponseFieldKind;
}

/** Finds pagination-related fields in a JSON response (objects only, not inside record arrays). */
export function findPaginationFields(value: unknown, maxDepth = 5): ResponseField[] {
  const found: ResponseField[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (!isPlainObject(v) || depth > maxDepth) return;
    for (const [key, child] of Object.entries(v)) {
      const childPath = path ? `${path}.${key}` : key;
      let kind = RESPONSE_KINDS[norm(key)];
      // `next` / `count` are only meaningful with the right value types.
      if (kind === "next-link" && !(typeof child === "string" || child === null)) kind = undefined;
      if (kind === "total" && typeof child !== "number") kind = undefined;
      if ((kind === "page" || kind === "offset" || kind === "limit") && typeof child !== "number" && typeof child !== "string" && child !== null)
        kind = undefined;
      if (norm(key) === "links" && isPlainObject(child) && "next" in child) {
        found.push({ path: `${childPath}.next`, kind: "next-link" });
      }
      if (kind) found.push({ path: childPath, kind });
      if (isPlainObject(child)) walk(child, childPath, depth + 1);
    }
  };
  walk(value, "", 0);
  return found;
}
