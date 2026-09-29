import { describe, expect, it } from "vitest";
import { buildContext } from "../src/analyzers/context.js";
import { analyzeEmbeddedState, extractBalanced } from "../src/analyzers/embedded-state/index.js";
import { capture, PRODUCTS, VISIBLE_PRODUCTS_TEXT } from "./helpers.js";

describe("embedded state detection", () => {
  it("finds window.__INITIAL_STATE__ and decides it can replace DOM scraping", () => {
    const html = `<html><body><script>window.dataLayer = [{"event":"pageview","page":"/x","user":"anon","id":1}];
window.__INITIAL_STATE__ = ${JSON.stringify({ catalog: { products: PRODUCTS } })};</script></body></html>`;
    const [state, ...rest] = analyzeEmbeddedState(buildContext(capture({ initialHtml: html, renderedText: VISIBLE_PRODUCTS_TEXT })));
    expect(rest).toHaveLength(0); // dataLayer is ignored
    expect(state).toMatchObject({ name: "__INITIAL_STATE__", kind: "window-assignment", locator: "window.__INITIAL_STATE__", parseable: true, canReplaceDom: true });
    expect(state?.assessment?.recordSet?.path).toBe("catalog.products");
  });

  it("handles JSON.parse('...') assignments and JSON script blocks", () => {
    const encoded = JSON.stringify(JSON.stringify({ items: PRODUCTS }));
    const html = `<script>window.__APP_DATA__ = JSON.parse(${encoded});</script>
<script id="__APOLLO_STATE__" type="application/json">${JSON.stringify({ "Product:1": PRODUCTS[0], "Product:2": PRODUCTS[1], "Product:3": PRODUCTS[2] })}</script>`;
    const found = analyzeEmbeddedState(buildContext(capture({ initialHtml: html, renderedText: VISIBLE_PRODUCTS_TEXT })));
    expect(found.map((f) => f.locator)).toEqual(expect.arrayContaining(["window.__APP_DATA__", "script#__APOLLO_STATE__"]));
    const apollo = found.find((f) => f.name === "__APOLLO_STATE__");
    expect(apollo?.assessment?.recordSet?.path).toBe("*");
  });

  it("classifies JSON-LD content vs metadata", () => {
    const product = { "@context": "https://schema.org", "@type": "Product", name: "Ergonomic Widget 1", offers: { "@type": "Offer", price: "10.00" } };
    const org = { "@context": "https://schema.org", "@type": "Organization", name: "Shop Inc", url: "https://shop.test" };
    const html = `<script type="application/ld+json">${JSON.stringify(product)}</script><script type="application/ld+json">${JSON.stringify(org)}</script>`;
    const found = analyzeEmbeddedState(buildContext(capture({ initialHtml: html, renderedText: "Ergonomic Widget 1 $10.00" })));
    const p = found.find((f) => f.jsonLdTypes?.includes("Product"));
    const o = found.find((f) => f.jsonLdTypes?.includes("Organization"));
    expect(p?.canReplaceDom).toBe(true);
    expect(o?.canReplaceDom).toBe(false);
    expect(p!.score).toBeGreaterThan(o!.score);
  });

  it("reports non-JSON serialized state as unparseable", () => {
    const html = `<script>window.__PRELOADED_STATE__ = {user: undefined, items: [1,2,3], note: 'this is not strict json at all'};</script>`;
    const [s] = analyzeEmbeddedState(buildContext(capture({ initialHtml: html })));
    expect(s).toMatchObject({ kind: "serialized-js", parseable: false, canReplaceDom: false });
  });

  it("extracts balanced literals containing braces in strings", () => {
    const src = `x = {"a":"}{","b":[1,{"c":"]"}]}; more`;
    expect(extractBalanced(src, 4)).toBe(`{"a":"}{","b":[1,{"c":"]"}]}`);
  });
});
