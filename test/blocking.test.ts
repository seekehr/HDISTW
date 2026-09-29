import { describe, expect, it } from "vitest";
import type { GeminiClient } from "../src/ai/gemini.js";
import { buildContext } from "../src/analyzers/context.js";
import { analyzeNextjs } from "../src/analyzers/nextjs/index.js";
import { buildReport } from "../src/inspect.js";
import { renderMarkdown } from "../src/reports/markdown.js";
import { capture } from "./helpers.js";

const challenge = capture({
  document: { status: 403, headers: { "cf-mitigated": "challenge", server: "cloudflare" }, redirectChain: [] },
  initialHtml: "<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>",
  renderedText: "quizlet.com\nPerforming security verification\nThis website uses a security service to protect against malicious bots.",
  dom: { title: "Just a moment...", hasPasswordField: false, paginationLinks: [], hasLoadMoreButton: false },
  cookies: [{ name: "__cf_bm", domain: ".shop.test", path: "/", httpOnly: true, secure: true, session: false }],
});

describe("bot-check pages", () => {
  it("reports blocked instead of recommending a strategy", async () => {
    let called = false;
    const gemini: GeminiClient = { model: "x", generate: async () => ((called = true), "{}") };
    const r = await buildReport(challenge, { gemini });
    expect(r.outcome).toBe("blocked");
    expect(r.blockedReason).toMatch(/Cloudflare challenge.*HTTP 403/);
    expect(r.strategies).toEqual([]);
    expect(r.recommendation.strategy).toBeNull();
    expect(r.codeExample).toBe("");
    expect(r.findings.auth.authRequired).toBe("unknown");
    expect(called).toBe(false);
    expect(r.recommendation.uncertainties.join(" ")).toMatch(/--login/);
    const md = renderMarkdown(r);
    expect(md).toContain("## Blocked");
    expect(md).not.toContain("## Recommended Extraction Strategy");
  });

  it("does not flag normal pages that merely mention captcha", async () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ") + " we use captcha on the signup form";
    const r = await buildReport(capture({ initialHtml: `<p>${text}</p>`, renderedText: text }));
    expect(r.outcome).toBe("analyzed");
  });
});

describe("record set choice", () => {
  it("prefers the visible list over a larger hidden config array", () => {
    const config = Array.from({ length: 40 }, (_, i) => ({ name: `Experiment${i}`, canEnroll: false, variation: "control" }));
    const shortcuts = ["Coding Knowledge", "Urdu", "Comp Sci", "Misc.", "Math", "Physics"].map((name, i) => ({
      modelId: String(1000 + i),
      name,
      url: `https://shop.test/folders/${i}`,
    }));
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { abTests: config, siteNav: { userShortcuts: shortcuts } } },
      buildId: "b",
    })}</script>`;
    const f = analyzeNextjs(buildContext(capture({ initialHtml: html, renderedText: "Your folders\nCoding Knowledge\nUrdu\nComp Sci\nMisc.\nMath\nPhysics" })));
    expect(f.nextData?.assessment.recordSet?.path).toBe("siteNav.userShortcuts");
  });

  it("still picks the biggest set when nothing is visible", () => {
    const f = analyzeNextjs(
      buildContext(
        capture({
          initialHtml: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
            props: { pageProps: { a: [{ id: 1, title: "x" }, { id: 2, title: "y" }], b: Array.from({ length: 9 }, (_, i) => ({ id: i, title: `t${i}` })) } },
          })}</script>`,
        }),
      ),
    );
    expect(f.nextData?.assessment.recordSet?.path).toBe("b");
  });
});

