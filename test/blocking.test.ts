import { describe, expect, it } from "vitest";
import type { GeminiClient } from "../src/ai/gemini.js";
import { buildReport, loginReason } from "../src/inspect.js";
import { renderMarkdown } from "../src/reports/markdown.js";
import { site } from "./sites.js";

describe("bot-check pages (real sites)", () => {
  it("Cloudflare challenge: reports blocked instead of recommending a strategy", async () => {
    let called = false;
    const gemini: GeminiClient = { model: "x", generate: async () => ((called = true), "{}") };
    const r = await buildReport(site("cf-challenge"), { gemini });
    expect(r.outcome).toBe("blocked");
    expect(r.blockedReason).toMatch(/Cloudflare challenge.*HTTP 403/);
    expect(r.strategies).toEqual([]);
    expect(r.recommendation.strategy).toBeNull();
    expect(r.codeExample).toBe("");
    expect(r.findings.auth.authRequired).toBe("unknown");
    expect(called).toBe(false);
    expect(r.recommendation.uncertainties.join(" ")).toMatch(/--login/);
    expect(loginReason(site("cf-challenge"))).toMatch(/bot check/);
    const md = renderMarkdown(r);
    expect(md).toContain("## Blocked");
    expect(md).not.toContain("## Recommended Extraction Strategy");
  });

  it("does not flag any of the real content pages as blocked", async () => {
    const pages = ["books-toscrape", "quotes-ssr", "quotes-js", "quotes-scroll", "hn-algolia", "anilist", "nextjs-org", "twitch", "airbnb", "crates", "hashnode", "bbc-news", "hackerone", "coursera", "github-settings"] as const;
    for (const name of pages) expect((await buildReport(site(name))).outcome, name).toBe("analyzed");
  });

  // Known gaps: block pages without Cloudflare's challenge header or wording.
  it.fails("IMDb: a bare CloudFront '403 Forbidden' is a block, not a page to scrape", async () => {
    expect((await buildReport(site("imdb-top"))).outcome).toBe("blocked");
  });

  it.fails("Reddit: 'Prove your humanity' (HTTP 200) is a bot check", async () => {
    expect((await buildReport(site("reddit-json"))).outcome).toBe("blocked");
  });

  it.fails("Allrecipes: Cloudflare HTTP 402 access block is a block", async () => {
    expect((await buildReport(site("allrecipes"))).outcome).toBe("blocked");
  });
});
