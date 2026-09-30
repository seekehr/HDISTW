import { describe, expect, it } from "vitest";
import { analyzeCapture } from "../src/analyzers/index.js";
import { site } from "./sites.js";

const pagination = (name: Parameters<typeof site>[0]) => analyzeCapture(site(name)).pagination;

describe("pagination detection (real sites)", () => {
  it("quotes.toscrape.com/scroll: page param plus has_next/page in the response", () => {
    const [p] = pagination("quotes-scroll");
    expect(p).toMatchObject({
      source: "rest",
      endpoint: "GET /api/quotes?page=1",
      type: "page",
      requestParams: ["page"],
      responseFields: ["has_next", "page"],
      confirmed: false, // only the first page was loaded
    });
  });

  it("crates.io: page/per_page in the API, confirmed by the page links", () => {
    const [api, html] = pagination("crates");
    expect(api).toMatchObject({ source: "rest", type: "page", requestParams: ["page", "per_page"], responseFields: ["meta.next_page"] });
    expect(html).toMatchObject({ source: "html", type: "page", requestParams: ["page"], confirmed: true });
  });

  it("hn.algolia.com: page/hitsPerPage read from the POST JSON body", () => {
    const [p] = pagination("hn-algolia");
    expect(p).toMatchObject({ source: "rest", type: "page", requestParams: ["page", "hitsPerPage"] });
    expect(p?.observedValues.page).toEqual(["0"]);
  });

  it("HackerOne: offset pagination from GraphQL variables (from/size)", () => {
    const p = pagination("hackerone").find((x) => x.endpoint.includes("HacktivitySearchQuery"));
    expect(p).toMatchObject({ source: "graphql", type: "offset" });
    expect(p?.requestParams).toEqual(expect.arrayContaining(["from", "size"]));
  });

  it("HackerOne: Relay cursor pagination from pageInfo", () => {
    const p = pagination("hackerone").find((x) => x.endpoint.includes("GetTeamsQuery"));
    expect(p).toMatchObject({ source: "graphql", type: "cursor" });
    expect(p?.responseFields).toContain("data.teams.pageInfo.endCursor");
  });

  it("books.toscrape.com: HTML pagination links", () => {
    const [p] = pagination("books-toscrape");
    expect(p).toMatchObject({ source: "html", type: "page" });
    expect(site("books-toscrape").dom.paginationLinks).toContain("https://books.toscrape.com/catalogue/page-2.html");
  });

  // Known gap: 20 tag links like /tag/love/page/1/ match the /page/N pattern and
  // fill the 20-link cap, so the real "Next →" link (/page/2/) is dropped.
  it.fails("quotes.toscrape.com: keeps the real next link over tag links", () => {
    expect(site("quotes-ssr").dom.paginationLinks).toContain("https://quotes.toscrape.com/page/2/");
  });

  it("reports nothing on pages without pagination", () => {
    expect(pagination("github-settings")).toEqual([]);
    expect(pagination("bbc-news")).toEqual([]);
  });

  // Known gap: Twitch batches operations, so the response root is an array and
  // pageInfo.hasNextPage inside it is never seen.
  it.fails("Twitch: detects cursor pagination in a batched GraphQL response", () => {
    const p = pagination("twitch").find((x) => x.endpoint.includes("BrowsePage_AllDirectories"));
    expect(p?.type).toBe("cursor");
  });
});
