import { describe, expect, it } from "vitest";
import { analyzeCapture } from "../src/analyzers/index.js";
import { capture, jsonReq, PRODUCTS, VISIBLE_PRODUCTS_TEXT } from "./helpers.js";

const run = (requests: ReturnType<typeof jsonReq>[], extra = {}) =>
  analyzeCapture(capture({ requests, renderedText: VISIBLE_PRODUCTS_TEXT, ...extra })).pagination;

describe("pagination detection", () => {
  it("detects cursor pagination from request param and response field", () => {
    const [p] = run([
      jsonReq("https://shop.test/api/items", { items: PRODUCTS, meta: { nextCursor: "abc" } }),
      jsonReq("https://shop.test/api/items?cursor=abc", { items: PRODUCTS, meta: { nextCursor: "def" } }, { phase: "interaction" }),
    ]);
    expect(p).toMatchObject({
      source: "rest",
      type: "cursor",
      requestParams: ["cursor"],
      responseFields: ["meta.nextCursor"],
      confirmed: false, // only one cursor value observed
    });
    expect(p?.evidence.join(" ")).toMatch(/triggered by interaction/);
  });

  it("detects cursor pagination from the response alone", () => {
    const [p] = run([jsonReq("https://shop.test/api/feed", { data: PRODUCTS, paging: { hasMore: true, next_cursor: "x" } })]);
    expect(p?.type).toBe("cursor");
    expect(p?.responseFields).toEqual(["paging.hasMore", "paging.next_cursor"]);
  });

  it("detects and confirms page-number pagination", () => {
    const [p] = run([
      jsonReq("https://shop.test/api/products?page=1&per_page=12", { data: PRODUCTS, totalPages: 4 }),
      jsonReq("https://shop.test/api/products?page=2&per_page=12", { data: PRODUCTS, totalPages: 4 }),
    ]);
    expect(p).toMatchObject({ type: "page", confirmed: true });
    expect(p?.requestParams).toEqual(["page", "per_page"]);
    expect(p?.observedValues.page).toEqual(["1", "2"]);
    expect(p?.evidence).toContain("2 requests with different `page` values");
  });

  it("detects offset/limit pagination, including in JSON bodies", () => {
    const [p] = run([
      jsonReq("https://shop.test/api/search", { results: PRODUCTS, total: 100 }, { method: "POST", postData: JSON.stringify({ q: "lamp", offset: 0, limit: 12 }) }),
      jsonReq("https://shop.test/api/search", { results: PRODUCTS, total: 100 }, { method: "POST", postData: JSON.stringify({ q: "lamp", offset: 12, limit: 12 }) }),
    ]);
    expect(p).toMatchObject({ type: "offset", confirmed: true });
    expect(p?.requestParams).toEqual(expect.arrayContaining(["offset", "limit"]));
  });

  it("detects token pagination (nextToken / continuationToken)", () => {
    const [p] = run([jsonReq("https://shop.test/api/list", { Items: PRODUCTS, nextToken: "eyJ..." })]);
    expect(p?.type).toBe("token");
  });

  it("detects Relay-style GraphQL pagination", () => {
    const pag = run([
      jsonReq("https://shop.test/graphql", { data: { list: { edges: PRODUCTS.map((node) => ({ node })), pageInfo: { hasNextPage: true, endCursor: "c" } } } }, {
        method: "POST",
        postData: JSON.stringify({ operationName: "List", query: "query List($first: Int, $after: String) { list { id } }", variables: { first: 12, after: null } }),
      }),
    ]);
    expect(pag[0]).toMatchObject({ source: "graphql", type: "cursor" });
    expect(pag[0]?.requestParams).toEqual(["first", "after"]);
  });

  it("does not report a lone limit param as pagination", () => {
    expect(run([jsonReq("https://shop.test/api/top?limit=5", { data: PRODUCTS })])).toHaveLength(0);
  });

  it("detects HTML pagination links", () => {
    const pag = run([], { dom: { title: "", hasPasswordField: false, hasLoadMoreButton: false, paginationLinks: ["https://shop.test/products?page=2", "https://shop.test/products?page=3"] } });
    expect(pag[0]).toMatchObject({ source: "html", type: "page", requestParams: ["page"], confirmed: true });
  });
});
