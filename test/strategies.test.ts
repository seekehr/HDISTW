import { describe, expect, it } from "vitest";
import { analyzeCapture } from "../src/analyzers/index.js";
import { extractNextData } from "../src/analyzers/nextjs/index.js";
import { accessor, generateExample } from "../src/codegen/index.js";
import { jsonBody } from "../src/utils/json.js";
import { buildRecommendation, paginationFor } from "../src/scoring/recommendation.js";
import { rankStrategies } from "../src/scoring/strategies.js";
import { site } from "./sites.js";

const ranked = (name: Parameters<typeof site>[0]) => rankStrategies(analyzeCapture(site(name)));

describe("strategy ranking (real sites)", () => {
  it.each([
    ["crates", "rest-api", "GET /api/v1/crates?page=1&per_page=50&sort=downloads"],
    ["quotes-scroll", "rest-api", "GET /api/quotes?page=1"],
    ["hackerone", "graphql", "POST https://hackerone.com/graphql (HacktivitySearchQuery)"],
    ["coursera", "graphql", "POST https://www.coursera.org/graphql-gateway (Search)"],
    ["bbc-news", "nextjs-data", "__NEXT_DATA__ → props.pageProps"],
    ["quotes-js", "embedded-json", "window.data"],
    ["airbnb", "embedded-json", "script#data-deferred-state-0"],
    ["books-toscrape", "ssr-html", "served HTML document"],
    ["quotes-ssr", "ssr-html", "served HTML document"],
  ] as const)("%s → %s", (name, id, source) => {
    expect(ranked(name)[0]).toMatchObject({ id, source, browserRequired: "no" });
  });

  it("hn.algolia.com: the Algolia API wins by a wide margin", () => {
    const [top, second] = ranked("hn-algolia");
    expect(top?.id).toBe("rest-api");
    expect(top!.score - second!.score).toBeGreaterThan(50);
  });

  it("BBC News: Next.js data outranks parsing the (also complete) HTML", () => {
    const r = ranked("bbc-news");
    expect(r.findIndex((s) => s.id === "nextjs-data")).toBeLessThan(r.findIndex((s) => s.id === "ssr-html"));
  });

  it("GitHub login redirect: the served HTML is the login page, so HTML parsing is capped", () => {
    const r = ranked("github-settings");
    expect(r[0]).toMatchObject({ id: "playwright-dom", browserRequired: "yes" });
    const ssr = r.find((s) => s.id === "ssr-html");
    expect(ssr!.score).toBeLessThanOrEqual(20);
    expect(ssr?.reasons).toContain("served HTML is the login page, not the content");
  });

  // Known gap: a config manifest.json outranks the GraphQL operation that renders the page.
  it.fails("Twitch: the directory GraphQL operation beats third-party config JSON", () => {
    expect(ranked("twitch")[0]?.id).toBe("graphql");
  });
});

describe("recommendation and code example (real sites)", () => {
  it("crates.io: page-number loop over the observed endpoint", () => {
    const cap = site("crates");
    const f = analyzeCapture(cap);
    const strategies = rankStrategies(f);
    const rec = buildRecommendation(cap, f, strategies);
    expect(rec).toMatchObject({ strategy: "rest-api", browserRequired: "no", generatedBy: "deterministic" });
    expect(rec.pagination).toMatch(/^Page-number-based/);
    expect(rec.avoid.join(" ")).toMatch(/DOM scraping/);
    const code = generateExample(rec.strategy!, f, cap.finalUrl, paginationFor(f, strategies[0]!));
    expect(code).toContain('new URL("https://crates.io/api/v1/crates?page=1&per_page=50&sort=downloads")');
    expect(code).toContain('url.searchParams.set("page", String(page))');
    expect(code).toContain("const records = data.crates;");
  });

  it("HackerOne: GraphQL example replays the observed query", () => {
    const cap = site("hackerone");
    const f = analyzeCapture(cap);
    const code = generateExample("graphql", f, cap.finalUrl);
    expect(code).toContain('fetch("https://hackerone.com/graphql"');
    expect(code).toContain('operationName: "HacktivitySearchQuery"');
    expect(code).toContain("const records = data.search.nodes;");
  });

  it("BBC News: Next.js example reads __NEXT_DATA__ from the page", () => {
    const cap = site("bbc-news");
    const code = generateExample("nextjs-data", analyzeCapture(cap), cap.finalUrl);
    expect(code).toContain('fetch("https://www.bbc.com/news")');
    expect(code).toContain("__NEXT_DATA__");
  });
});

describe("codegen accessors against real payloads", () => {
  /** Evaluates the generated accessor expression against the real JSON. */
  const run = (root: string, path: string, value: unknown) => new Function(root, `return ${accessor(root, path)};`)(value) as unknown[];

  it("crates.io: data.crates", () => {
    const f = analyzeCapture(site("crates"));
    const req = site("crates").requests.find((r) => r.url === f.rest[0]!.url)!;
    expect(accessor("data", "crates")).toBe("data.crates");
    expect(run("data", "crates", jsonBody(req)!.value)).toHaveLength(50);
  });

  const isRecord = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);

  // Known gap: `sections[].content` maps to an array of arrays (needs flatMap).
  it.fails("BBC News: `a[].b` paths yield the records themselves", () => {
    const rs = analyzeCapture(site("bbc-news")).nextjs.nextData!.assessment.recordSet!;
    const pageProps = (extractNextData(site("bbc-news").initialHtml)!.value.props as { pageProps: unknown }).pageProps;
    const records = run("p", rs.path, pageProps);
    expect(records.every(isRecord)).toBe(true);
  });

  // Known gap: `niobeClientData[][].data...` generates code that throws.
  it.fails("Airbnb: nested `[][]` paths evaluate", () => {
    const e = analyzeCapture(site("airbnb")).embeddedState[0]!;
    const raw = /<script[^>]*id="data-deferred-state-0"[^>]*>([\s\S]*?)<\/script>/.exec(site("airbnb").initialHtml)![1]!;
    expect(run("state", e.assessment!.recordSet!.path, JSON.parse(raw)).every(isRecord)).toBe(true);
  });
});
