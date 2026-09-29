import { describe, expect, it } from "vitest";
import { analyzeCapture } from "../src/analyzers/index.js";
import { accessor, generateExample } from "../src/codegen/index.js";
import { buildRecommendation } from "../src/scoring/recommendation.js";
import { rankStrategies } from "../src/scoring/strategies.js";
import { capture, jsonReq, PRODUCTS, VISIBLE_PRODUCTS_TEXT } from "./helpers.js";

const shell = `<html><body><div id="root"></div></body></html>`;
const ssr = `<html><body>${PRODUCTS.map((p) => `<p>${p.title}</p><p>$${p.price}.00</p>`).join("")}</body></html>`;
const products = (extra = {}) => jsonReq("https://shop.test/api/products?page=1", { data: PRODUCTS, meta: { nextPage: 2 } }, extra);

describe("strategy ranking", () => {
  it("prefers a direct REST API when it carries the visible data", () => {
    const f = analyzeCapture(capture({ initialHtml: shell, renderedText: VISIBLE_PRODUCTS_TEXT, requests: [products()] }));
    const ranked = rankStrategies(f);
    expect(ranked.map((s) => s.id)).toEqual(["rest-api", "playwright-dom", "ssr-html"]);
    expect(ranked[0]).toMatchObject({ source: "GET /api/products?page=1", browserRequired: "no" });
    expect(ranked[0]!.score).toBeGreaterThan(90);
    expect(ranked.at(-1)!.score).toBeLessThan(20);
  });

  it("prefers HTML parsing for plain server-rendered pages", () => {
    const [top] = rankStrategies(analyzeCapture(capture({ initialHtml: ssr, renderedText: VISIBLE_PRODUCTS_TEXT })));
    expect(top?.id).toBe("ssr-html");
  });

  it("falls back to Playwright when nothing structured exists", () => {
    const ranked = rankStrategies(analyzeCapture(capture({ initialHtml: shell, renderedText: VISIBLE_PRODUCTS_TEXT })));
    expect(ranked[0]).toMatchObject({ id: "playwright-dom", browserRequired: "yes" });
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(70);
  });

  it("recommends browser login + direct HTTP when the API needs auth", () => {
    const f = analyzeCapture(
      capture({ initialHtml: shell, renderedText: VISIBLE_PRODUCTS_TEXT, requests: [products({ requestHeaders: { authorization: "Bearer [REDACTED]" } })] }),
    );
    const ranked = rankStrategies(f);
    expect(ranked[0]).toMatchObject({ id: "browser-auth-http", browserRequired: "login-only" });
    expect(ranked.find((s) => s.id === "rest-api")!.score).toBeLessThan(ranked[0]!.score);
  });

  it("ranks Next.js data above HTML parsing when __NEXT_DATA__ has the records", () => {
    const html = ssr.replace(
      "</body>",
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { items: PRODUCTS } }, buildId: "b1", page: "/" })}</script></body>`,
    );
    const ranked = rankStrategies(analyzeCapture(capture({ initialHtml: html, renderedText: VISIBLE_PRODUCTS_TEXT })));
    expect(ranked[0]?.id).toBe("nextjs-data");
    expect(ranked.findIndex((s) => s.id === "nextjs-data")).toBeLessThan(ranked.findIndex((s) => s.id === "ssr-html"));
  });

  it("builds a deterministic recommendation and example", () => {
    const cap = capture({
      initialHtml: shell,
      renderedText: VISIBLE_PRODUCTS_TEXT,
      requests: [products(), jsonReq("https://shop.test/api/products?page=2", { data: PRODUCTS, meta: { nextPage: 3 } }, { phase: "interaction" })],
    });
    const f = analyzeCapture(cap);
    const ranked = rankStrategies(f);
    const rec = buildRecommendation(cap, f, ranked);
    expect(rec).toMatchObject({ strategy: "rest-api", browserRequired: "no", generatedBy: "deterministic" });
    expect(rec.pagination).toMatch(/^Page-number-based/);
    expect(rec.avoid.join(" ")).toMatch(/DOM scraping/);
    const code = generateExample(rec.strategy, f, cap.finalUrl, f.pagination[0]);
    expect(code).toContain('url.searchParams.set("page", String(page))');
    expect(code).toContain("const records = data.data;");
  });
});

describe("codegen accessors", () => {
  it("maps record paths to JS", () => {
    expect(accessor("data", "items")).toBe("data.items");
    expect(accessor("data", "products.edges[].node")).toBe("data.products.edges.map((item) => item.node)");
    expect(accessor("state", "*")).toBe("Object.values(state)");
    expect(accessor("d", "some-key.x")).toBe('d["some-key"].x');
  });
});
