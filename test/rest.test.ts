import { describe, expect, it } from "vitest";
import { buildContext } from "../src/analyzers/context.js";
import { analyzeRest } from "../src/analyzers/rest/index.js";
import { capture, jsonReq, PRODUCTS, req, VISIBLE_PRODUCTS_TEXT } from "./helpers.js";

describe("REST endpoint detection", () => {
  const products = jsonReq("https://shop.test/api/products?page=1", { data: PRODUCTS, meta: { page: 1, totalPages: 4 } });
  const config = jsonReq("https://shop.test/api/config", { theme: "dark", locale: "en", flags: { beta: true } });
  const cart = jsonReq("https://shop.test/api/cart", { items: [], total: 0 });

  it("ranks the endpoint that carries the visible records first", () => {
    const ctx = buildContext(capture({ requests: [config, cart, products], renderedText: VISIBLE_PRODUCTS_TEXT }));
    const [best] = analyzeRest(ctx);
    expect(best?.display).toBe("GET /api/products?page=1");
    expect(best?.score).toBeGreaterThanOrEqual(90);
    expect(best?.reasons).toContain("JSON response");
    expect(best?.reasons.join(" ")).toMatch(/repeated records \(12 at data\)/);
    expect(best?.reasons.join(" ")).toMatch(/visible content matches response \(100%/);
    expect(best?.reasons.join(" ")).toMatch(/pagination fields/);
    expect(best?.assessment.recordSet?.signals).toEqual(expect.arrayContaining(["id", "title", "price", "image"]));
  });

  it("does not treat every JSON response as a data source", () => {
    const ctx = buildContext(capture({ requests: [config, cart, products], renderedText: VISIBLE_PRODUCTS_TEXT }));
    const results = analyzeRest(ctx);
    const configResult = results.find((c) => c.display.includes("/api/config"));
    expect(configResult === undefined || configResult.score < 40).toBe(true);
  });

  it("scores lower when records are not visible on the page", () => {
    const visible = analyzeRest(buildContext(capture({ requests: [products], renderedText: VISIBLE_PRODUCTS_TEXT })))[0];
    const hidden = analyzeRest(buildContext(capture({ requests: [products], renderedText: "Something else entirely" })))[0];
    expect(hidden!.score).toBeLessThan(visible!.score);
  });

  it("penalizes error responses and ignores non-JSON", () => {
    const denied = jsonReq("https://shop.test/api/products", { data: PRODUCTS }, { status: 403 });
    const html = req({ url: "https://shop.test/fragment", bodyText: "<div>hi</div>", contentType: "text/html" });
    const results = analyzeRest(buildContext(capture({ requests: [denied, html], renderedText: VISIBLE_PRODUCTS_TEXT })));
    expect(results.every((c) => c.score < 40)).toBe(true);
    expect(results.find((c) => c.url.includes("fragment"))).toBeUndefined();
  });

  it("groups repeated calls to the same endpoint", () => {
    const p2 = jsonReq("https://shop.test/api/products?page=2", { data: PRODUCTS, meta: { page: 2 } }, { phase: "interaction" });
    const results = analyzeRest(buildContext(capture({ requests: [products, p2], renderedText: VISIBLE_PRODUCTS_TEXT })));
    expect(results).toHaveLength(1);
    expect(results[0]?.occurrences).toBe(2);
    expect(results[0]?.phase).toBe("initial");
  });
});
