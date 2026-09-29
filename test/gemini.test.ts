import { describe, expect, it } from "vitest";
import type { GeminiClient } from "../src/ai/gemini.js";
import { buildReport } from "../src/inspect.js";
import { capture, jsonReq, PRODUCTS, VISIBLE_PRODUCTS_TEXT } from "./helpers.js";

const cap = capture({
  initialHtml: "<html><body><div id=root></div></body></html>",
  renderedText: VISIBLE_PRODUCTS_TEXT,
  requests: [jsonReq("https://shop.test/api/products?page=1", { data: PRODUCTS, meta: { nextPage: 2 } }, { requestHeaders: { cookie: "[REDACTED]: 1 cookie" } })],
});

function fakeClient(answer: unknown): GeminiClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    model: "fake-gemini",
    prompts,
    async generate(_system, prompt) {
      prompts.push(prompt);
      return typeof answer === "string" ? answer : JSON.stringify(answer);
    },
  };
}

const valid = {
  strategy: "rest-api",
  source: "GET /api/products?page=1",
  why: "The endpoint returns the product records shown on the page.",
  browserRequired: "no",
  browserOnlyForAuth: false,
  pagination: "Increment `page` until `meta.nextPage` is null.",
  statePreserve: [],
  avoid: ["DOM scraping"],
  uncertainties: [],
};

describe("Gemini analysis", () => {
  it("uses a valid Gemini recommendation", async () => {
    const client = fakeClient(valid);
    const report = await buildReport(cap, { gemini: client });
    expect(report.ai).toMatchObject({ used: true, model: "fake-gemini" });
    expect(report.recommendation).toMatchObject({ generatedBy: "gemini", source: "GET /api/products?page=1" });
    expect(client.prompts[0]).toContain("candidateEndpoints");
  });

  it("rejects endpoints Gemini invented", async () => {
    const report = await buildReport(cap, {
      gemini: fakeClient({ ...valid, source: "GET https://shop.test/api/v9/secret-export", why: "Use GET https://shop.test/api/v9/all instead." }),
    });
    expect(report.recommendation.source).toBe("GET /api/products?page=1");
    expect(report.recommendation.uncertainties.join(" ")).toMatch(/unobserved source/);
    expect(report.recommendation.uncertainties.join(" ")).toMatch(/not observed.*api\/v9\/all/);
  });

  it("falls back to the deterministic recommendation on bad output or errors", async () => {
    const bad = await buildReport(cap, { gemini: fakeClient("not json") });
    expect(bad.recommendation.generatedBy).toBe("deterministic");
    expect(bad.ai.used).toBe(false);

    const failing: GeminiClient = { model: "x", generate: () => Promise.reject(new Error("quota exceeded")) };
    const failed = await buildReport(cap, { gemini: failing });
    expect(failed.recommendation.generatedBy).toBe("deterministic");
    expect(failed.ai.note).toMatch(/quota exceeded/);
  });

  it("rejects strategies that were not ranked", async () => {
    const report = await buildReport(cap, { gemini: fakeClient({ ...valid, strategy: "graphql" }) });
    expect(report.recommendation.generatedBy).toBe("deterministic");
  });
});
