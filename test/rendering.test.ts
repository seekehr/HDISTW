import { describe, expect, it } from "vitest";
import { analyzeCapture } from "../src/analyzers/index.js";
import { site } from "./sites.js";

const rendering = (name: Parameters<typeof site>[0]) => analyzeCapture(site(name)).rendering;

describe("rendering classification (real sites)", () => {
  it("server-rendered: books.toscrape.com, quotes.toscrape.com", () => {
    for (const name of ["books-toscrape", "quotes-ssr"] as const) {
      const r = rendering(name);
      expect(r.type).toBe("server-rendered");
      expect(r.initialHtmlCoverage).toBeGreaterThan(0.9);
    }
  });

  it("hybrid: Hashnode ships SSR content and also fetches data during load", () => {
    const r = rendering("hashnode");
    expect(r.type).toBe("hybrid");
    expect(r.traits).toContain("page data fetched by JavaScript during load");
  });

  it("API-driven: quotes/scroll, crates.io and HackerOne fill an empty shell from an API", () => {
    for (const name of ["quotes-scroll", "crates", "hackerone"] as const) {
      const r = rendering(name);
      expect(r.type).toBe("API-driven");
      expect(r.initialHtmlCoverage).toBeLessThan(0.35);
      expect(r.traits).toContain("page data fetched by JavaScript during load");
    }
  });

  it("embedded-state-driven: quotes/js and Airbnb render from serialized state", () => {
    for (const name of ["quotes-js", "airbnb"] as const) {
      const r = rendering(name);
      expect(r.type).toBe("embedded-state-driven");
      expect(r.traits).toContain("page data serialized in the HTML");
    }
  });

  it("notes the Next.js router as a trait", () => {
    expect(rendering("bbc-news").traits).toContain("Next.js (pages router)");
    expect(rendering("nextjs-org").traits).toContain("Next.js (app router)");
  });
});
