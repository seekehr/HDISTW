import { describe, expect, it } from "vitest";
import { buildContext } from "../src/analyzers/context.js";
import { analyzeRest } from "../src/analyzers/rest/index.js";
import { site } from "./sites.js";

const rest = (name: Parameters<typeof site>[0]) => analyzeRest(buildContext(site(name)));

describe("REST endpoint detection (real sites)", () => {
  it("crates.io: ranks the endpoint that carries the visible crates first", () => {
    const [best] = rest("crates");
    expect(best?.display).toBe("GET /api/v1/crates?page=1&per_page=50&sort=downloads");
    expect(best?.score).toBeGreaterThanOrEqual(90);
    expect(best?.reasons).toEqual(expect.arrayContaining(["JSON response", "fetch/XHR request", "API-like path"]));
    expect(best?.assessment.recordSet).toMatchObject({ path: "crates", count: 50 });
    expect(best?.assessment.recordSet?.signals).toEqual(expect.arrayContaining(["id", "title"]));
    expect(best?.assessment.visibleOverlap).toBe(1);
  });

  it("crates.io: an unrelated third-party record list scores well below the page data", () => {
    const results = rest("crates");
    const playground = results.find((c) => c.url.includes("play.rust-lang.org"));
    expect(playground).toBeDefined();
    expect(playground!.assessment.visibleOverlap).toBeLessThan(0.1);
    expect(playground!.score).toBeLessThan(results[0]!.score - 30);
  });

  it("quotes.toscrape.com/scroll: finds the infinite-scroll API", () => {
    const [best] = rest("quotes-scroll");
    expect(best).toMatchObject({ display: "GET /api/quotes?page=1", sentCookies: false, sentAuthorization: false });
    expect(best?.assessment.recordSet).toMatchObject({ path: "quotes", count: 10 });
    expect(best?.reasons.join(" ")).toMatch(/pagination fields \(has_next, page\)/);
  });

  it("hn.algolia.com: finds the cross-origin POST search API", () => {
    const [best] = rest("hn-algolia");
    expect(best?.method).toBe("POST");
    expect(best?.url).toMatch(/^https:\/\/uj5wyc0l7x-dsn\.algolia\.net\/1\/indexes\/Item_dev\/query/);
    expect(best?.assessment.recordSet).toMatchObject({ path: "hits", count: 10 });
    expect(best?.requestBody).toContain('"query":"typescript"');
  });

  it("scores lower when the same response is not visible on the page", () => {
    const cap = site("crates");
    const visible = analyzeRest(buildContext(cap))[0]!;
    const hidden = analyzeRest(buildContext({ ...cap, renderedText: "" })).find((c) => c.endpointKey === visible.endpointKey)!;
    expect(hidden.score).toBeLessThan(visible.score);
    expect(hidden.assessment.visibleOverlap).toBe(0);
  });

  it("does not treat SSR pages or GraphQL traffic as REST sources", () => {
    expect(rest("books-toscrape")).toEqual([]);
    expect(rest("quotes-ssr")).toEqual([]);
    expect(rest("hackerone").some((c) => c.url.includes("/graphql"))).toBe(false);
  });

  it("marks configuration endpoints as such (BBC's Piano SDK assets)", () => {
    const piano = rest("bbc-news").find((c) => c.url.includes("piano.io/api/v3/anon/assets"));
    expect(piano?.reasons).toContain("looks like configuration/session metadata, not page data");
  });

  it("groups repeated calls to the same endpoint (Coursera event batching)", () => {
    const eventing = rest("coursera").filter((c) => c.display.startsWith("POST /api/rest/v1/eventing/infobatch"));
    expect(eventing).toHaveLength(1);
    expect(eventing[0]!.occurrences).toBeGreaterThan(1);
  });
});
