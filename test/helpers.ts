import type { Capture, CapturedRequest } from "../src/schemas/capture.js";

let nextId = 1;

export function req(partial: Partial<CapturedRequest> & { url: string }): CapturedRequest {
  const body = partial.bodyText;
  return {
    id: nextId++,
    method: "GET",
    resourceType: "fetch",
    requestHeaders: {},
    responseHeaders: {},
    status: 200,
    contentType: body !== undefined ? "application/json" : undefined,
    isNavigation: false,
    startedAt: 0,
    ...partial,
  };
}

export function jsonReq(url: string, body: unknown, partial: Partial<CapturedRequest> = {}): CapturedRequest {
  return req({ url, bodyText: JSON.stringify(body), ...partial });
}

export function capture(partial: Partial<Capture> = {}): Capture {
  return {
    target: "https://shop.test/products",
    finalUrl: "https://shop.test/products",
    startedAt: new Date(0).toISOString(),
    durationMs: 1000,
    usedLoginWindow: false,
    document: { status: 200, headers: {}, redirectChain: [] },
    initialHtml: "<html><body></body></html>",
    renderedHtml: "<html><body></body></html>",
    renderedText: "",
    dom: { title: "Shop", hasPasswordField: false, paginationLinks: [], hasLoadMoreButton: false },
    requests: [],
    ignored: { total: 0, byReason: {} },
    cookies: [],
    errors: [],
    ...partial,
  };
}

export const PRODUCTS = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1,
  title: `Ergonomic Widget ${i + 1}`,
  price: 10 + i,
  image: `https://cdn.shop.test/img/${i + 1}.jpg`,
  slug: `widget-${i + 1}`,
}));

export const VISIBLE_PRODUCTS_TEXT = PRODUCTS.map((p) => `${p.title}\n$${p.price}.00`).join("\n");
