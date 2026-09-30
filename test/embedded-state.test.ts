import { describe, expect, it } from "vitest";
import { buildContext } from "../src/analyzers/context.js";
import { analyzeEmbeddedState, extractBalanced } from "../src/analyzers/embedded-state/index.js";
import { site } from "./sites.js";

const embedded = (name: Parameters<typeof site>[0]) => analyzeEmbeddedState(buildContext(site(name)));

describe("embedded state detection (real sites)", () => {
  it("quotes.toscrape.com/js: finds `var data = [...]` and decides it can replace DOM scraping", () => {
    const [state, ...rest] = embedded("quotes-js");
    expect(rest).toHaveLength(0);
    expect(state).toMatchObject({ name: "data", kind: "window-assignment", locator: "window.data", parseable: true, canReplaceDom: true });
    expect(state?.assessment?.recordSet).toMatchObject({ path: "", count: 10 });
    expect(state?.assessment?.visibleOverlap).toBe(1);
  });

  it("quotes.toscrape.com/js: extractBalanced pulls the literal out of the real script", () => {
    const html = site("quotes-js").initialHtml;
    const start = html.indexOf("[", html.indexOf("var data"));
    const literal = extractBalanced(html, start);
    expect(JSON.parse(literal!)).toHaveLength(10);
  });

  it("Airbnb: the JSON script with the search results replaces DOM scraping", () => {
    const [best] = embedded("airbnb");
    expect(best).toMatchObject({ locator: "script#data-deferred-state-0", kind: "json-script", canReplaceDom: true });
    expect(best?.assessment?.recordSet?.path).toMatch(/staysSearch/);
    expect(best?.assessment?.visibleOverlap).toBeGreaterThanOrEqual(0.5);
  });

  it("Coursera: finds window.__APOLLO_STATE__", () => {
    const apollo = embedded("coursera").find((e) => e.locator === "window.__APOLLO_STATE__");
    expect(apollo).toMatchObject({ kind: "window-assignment", parseable: true });
  });

  it("Hashnode: content JSON-LD beats metadata JSON-LD", () => {
    const found = embedded("hashnode");
    const list = found.find((e) => e.jsonLdTypes?.includes("ItemList"));
    const website = found.find((e) => e.jsonLdTypes?.includes("WebSite"));
    expect(list).toMatchObject({ kind: "json-ld", canReplaceDom: true });
    expect(list?.reasons.join(" ")).toMatch(/schema\.org content types/);
    expect(website).toMatchObject({ canReplaceDom: false });
    expect(website?.reasons.join(" ")).toMatch(/metadata only/);
    expect(list!.score).toBeGreaterThan(website!.score);
  });

  it("AniList: ItemList JSON-LD that is not what the page shows cannot replace the DOM", () => {
    const [ld] = embedded("anilist");
    expect(ld?.jsonLdTypes).toContain("ItemList");
    expect(ld?.canReplaceDom).toBe(false);
  });

  it("ignores __NEXT_DATA__ (reported by the Next.js analyzer)", () => {
    expect(embedded("bbc-news").some((e) => e.locator.includes("__NEXT_DATA__"))).toBe(false);
  });
});
