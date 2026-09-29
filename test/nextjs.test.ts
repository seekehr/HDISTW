import { describe, expect, it } from "vitest";
import { buildContext } from "../src/analyzers/context.js";
import { detectFramework } from "../src/analyzers/framework.js";
import { analyzeNextjs, extractNextData } from "../src/analyzers/nextjs/index.js";
import { capture, jsonReq, PRODUCTS, req, VISIBLE_PRODUCTS_TEXT } from "./helpers.js";

const nextData = {
  props: { pageProps: { products: PRODUCTS, total: 48 } },
  page: "/products",
  query: {},
  buildId: "abc123XYZ",
  gssp: true,
};
const html = `<html><head><script src="/_next/static/chunks/main-1.js"></script></head><body><div id="__next"></div>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`;

describe("Next.js detection", () => {
  it("extracts __NEXT_DATA__ and assesses pageProps", () => {
    expect(extractNextData(html)?.value.buildId).toBe("abc123XYZ");
    const ctx = buildContext(capture({ initialHtml: html, renderedText: VISIBLE_PRODUCTS_TEXT }));
    const f = analyzeNextjs(ctx);
    expect(f.detected).toBe(true);
    expect(f.router).toBe("pages");
    expect(f.buildId).toBe("abc123XYZ");
    expect(f.page).toBe("/products");
    expect(f.dataFetching).toContain("getServerSideProps");
    expect(f.signals).toEqual(expect.arrayContaining(["__NEXT_DATA__ script", "/_next/static assets"]));
    expect(f.nextData?.pagePropsKeys).toEqual(["products", "total"]);
    expect(f.nextData?.assessment.recordSet).toMatchObject({ path: "products", count: 12 });
    expect(f.nextData?.assessment.visibleOverlap).toBe(1);
  });

  it("derives (but labels) the /_next/data URL when none was observed", () => {
    const f = analyzeNextjs(buildContext(capture({ initialHtml: html })));
    expect(f.derivedDataUrl).toBe("https://shop.test/_next/data/abc123XYZ/products.json");
  });

  it("reports observed /_next/data requests instead of deriving", () => {
    const data = jsonReq("https://shop.test/_next/data/abc123XYZ/products.json?page=2", { pageProps: { products: PRODUCTS } });
    const f = analyzeNextjs(buildContext(capture({ initialHtml: html, requests: [data], renderedText: VISIBLE_PRODUCTS_TEXT })));
    expect(f.dataRequests).toHaveLength(1);
    expect(f.dataRequests[0]?.assessment.recordSet?.path).toBe("products");
    expect(f.derivedDataUrl).toBeUndefined();
  });

  it("detects App Router / RSC flight requests", () => {
    const appHtml = `<html><body><script src="/_next/static/chunks/app/page-1.js"></script><script>self.__next_f.push([1,"..."])</script></body></html>`;
    const rsc = req({ url: "https://shop.test/products?_rsc=1x2y", requestHeaders: { rsc: "1" }, contentType: "text/x-component" });
    const f = analyzeNextjs(buildContext(capture({ initialHtml: appHtml, requests: [rsc] })));
    expect(f.router).toBe("app");
    expect(f.flightDataInHtml).toBe(true);
    expect(f.rscRequests).toHaveLength(1);
    expect(f.dataFetching).toContain("React Server Components");
  });

  it("names the framework", () => {
    expect(detectFramework(capture({ initialHtml: html })).name).toBe("Next.js");
    expect(detectFramework(capture({ initialHtml: "<html><body>plain</body></html>" })).name).toBe("none detected");
  });
});
