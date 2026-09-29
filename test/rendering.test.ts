import { describe, expect, it } from "vitest";
import { analyzeCapture } from "../src/analyzers/index.js";
import { capture, jsonReq, PRODUCTS, VISIBLE_PRODUCTS_TEXT } from "./helpers.js";

const ssrHtml = `<html><body><h1>Products</h1><ul>${PRODUCTS.map((p) => `<li><span>${p.title}</span> <b>$${p.price}.00</b></li>`).join("")}</ul></body></html>`;
const shell = `<html><body><div id="root"></div><script src="/app.js"></script></body></html>`;
const api = (phase: "initial" | "interaction" = "initial") => jsonReq("https://shop.test/api/products", { products: PRODUCTS }, { phase });

describe("rendering classification", () => {
  it("server-rendered: content is in the served HTML", () => {
    const r = analyzeCapture(capture({ initialHtml: ssrHtml, renderedText: VISIBLE_PRODUCTS_TEXT })).rendering;
    expect(r.type).toBe("server-rendered");
    expect(r.initialHtmlCoverage).toBeGreaterThan(0.9);
  });

  it("hybrid: SSR content plus data APIs during load", () => {
    const r = analyzeCapture(capture({ initialHtml: ssrHtml, renderedText: VISIBLE_PRODUCTS_TEXT, requests: [api()] })).rendering;
    expect(r.type).toBe("hybrid");
  });

  it("API-driven: empty shell filled from an API", () => {
    const r = analyzeCapture(capture({ initialHtml: shell, renderedText: VISIBLE_PRODUCTS_TEXT, requests: [api()] })).rendering;
    expect(r.type).toBe("API-driven");
    expect(r.initialHtmlCoverage).toBe(0);
    expect(r.traits).toContain("page data fetched by JavaScript during load");
  });

  it("client-rendered: empty shell, no identifiable data source", () => {
    const r = analyzeCapture(capture({ initialHtml: shell, renderedText: VISIBLE_PRODUCTS_TEXT })).rendering;
    expect(r.type).toBe("client-rendered");
  });

  it("embedded-state-driven: shell plus serialized state", () => {
    const html = shell.replace("</body>", `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ products: PRODUCTS })}</script></body>`);
    const r = analyzeCapture(capture({ initialHtml: html, renderedText: VISIBLE_PRODUCTS_TEXT })).rendering;
    expect(r.type).toBe("embedded-state-driven");
  });

  it("interaction-dependent: data only arrives after interaction", () => {
    const r = analyzeCapture(
      capture({ initialHtml: shell, renderedText: "Search products", interactionText: VISIBLE_PRODUCTS_TEXT, requests: [api("interaction")], interactive: true }),
    ).rendering;
    expect(r.type).toBe("interaction-dependent");
  });
});
