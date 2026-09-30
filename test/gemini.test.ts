import { describe, expect, it } from "vitest";
import type { GeminiClient } from "../src/ai/gemini.js";
import { buildReport } from "../src/inspect.js";
import { site } from "./sites.js";

// A real crates.io capture; Gemini itself is stubbed (tests never call the API).
const SOURCE = "GET /api/v1/crates?page=1&per_page=50&sort=downloads";

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
  source: SOURCE,
  why: "The endpoint returns the crates listed on the page.",
  browserRequired: "no",
  browserOnlyForAuth: false,
  pagination: "Increment `page` until `meta.next_page` is null.",
  statePreserve: [],
  avoid: ["DOM scraping"],
  uncertainties: [],
};

describe("Gemini analysis (real crates.io capture)", () => {
  it("uses a valid Gemini recommendation", async () => {
    const client = fakeClient(valid);
    const report = await buildReport(site("crates"), { gemini: client });
    expect(report.ai).toMatchObject({ used: true, model: "fake-gemini" });
    expect(report.recommendation).toMatchObject({ generatedBy: "gemini", source: SOURCE });
    expect(client.prompts[0]).toContain("candidateEndpoints");
    expect(client.prompts[0]).toContain("/api/v1/crates");
  });

  it("rejects endpoints Gemini invented", async () => {
    const report = await buildReport(site("crates"), {
      gemini: fakeClient({ ...valid, source: "GET https://crates.io/api/v9/secret-export", why: "Use GET https://crates.io/api/v9/all instead." }),
    });
    expect(report.recommendation.source).toBe(SOURCE);
    expect(report.recommendation.uncertainties.join(" ")).toMatch(/unobserved source/);
    expect(report.recommendation.uncertainties.join(" ")).toMatch(/not observed.*api\/v9\/all/);
  });

  it("accepts an observed URL mentioned in the text", async () => {
    const report = await buildReport(site("crates"), { gemini: fakeClient({ ...valid, why: "Call GET https://crates.io/api/v1/crates directly." }) });
    expect(report.recommendation.uncertainties.join(" ")).not.toMatch(/not observed/);
  });

  it("falls back to the deterministic recommendation on bad output or errors", async () => {
    const bad = await buildReport(site("crates"), { gemini: fakeClient("not json") });
    expect(bad.recommendation.generatedBy).toBe("deterministic");
    expect(bad.ai.used).toBe(false);

    const failing: GeminiClient = { model: "x", generate: () => Promise.reject(new Error("quota exceeded")) };
    const failed = await buildReport(site("crates"), { gemini: failing });
    expect(failed.recommendation.generatedBy).toBe("deterministic");
    expect(failed.ai.note).toMatch(/quota exceeded/);
  });

  it("rejects strategies that were not ranked", async () => {
    const report = await buildReport(site("crates"), { gemini: fakeClient({ ...valid, strategy: "graphql" }) });
    expect(report.recommendation.generatedBy).toBe("deterministic");
  });
});
