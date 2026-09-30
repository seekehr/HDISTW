import { describe, expect, it } from "vitest";
import { buildSanitizedSummary } from "../src/ai/sanitize.js";
import { analyzeCapture } from "../src/analyzers/index.js";
import { buildReport } from "../src/inspect.js";
import { renderMarkdown } from "../src/reports/markdown.js";
import { buildRecommendation } from "../src/scoring/recommendation.js";
import { rankStrategies } from "../src/scoring/strategies.js";
import { jsonBody } from "../src/utils/json.js";
import { redactText } from "../src/utils/redact.js";
import { SITES, site } from "./sites.js";

describe("secret redaction (real captures)", () => {
  it("no recorded capture keeps a cookie, authorization or session header value", () => {
    for (const { name } of SITES) {
      const cap = site(name);
      for (const r of cap.requests) {
        for (const [k, v] of Object.entries({ ...r.requestHeaders, ...r.responseHeaders })) {
          if (k === "cookie") expect(v, `${name} ${k}`).toMatch(/^\[REDACTED\]: \d+ cookies?$/);
          else if (k === "authorization") expect(v, `${name} ${k}`).toMatch(/\[REDACTED\]$/);
          else if (/set-cookie|session|csrf|xsrf|token|api[-_]?key/i.test(k)) expect(v, `${name} ${k}`).toBe("[REDACTED]");
        }
      }
      expect(JSON.stringify(cap.cookies), name).not.toMatch(/"value"/);
    }
  });

  it("hn.algolia.com: the Algolia API key in the query string is redacted", () => {
    const req = site("hn-algolia").requests.find((r) => r.url.includes("algolia.net/1/indexes"));
    expect(req?.url).toContain("x-algolia-api-key=REDACTED");
    expect(req?.url).toContain("x-algolia-application-id=UJ5WYC0L7X");
  });

  it("Twitch: client-session-id is redacted, the public client-id is kept", () => {
    const req = site("twitch").requests.find((r) => r.url === "https://gql.twitch.tv/gql");
    expect(req?.requestHeaders["client-session-id"]).toBe("[REDACTED]");
    expect(req?.requestHeaders["client-id"]).toMatch(/^[a-z0-9]{30}$/);
  });

  it("never sends page content or request bodies to Gemini", () => {
    const cap = site("hn-algolia");
    const f = analyzeCapture(cap);
    const strategies = rankStrategies(f);
    const text = JSON.stringify(buildSanitizedSummary(cap, f, strategies, buildRecommendation(cap, f, strategies)).summary);
    const req = cap.requests.find((r) => r.url.includes("algolia.net/1/indexes"))!;
    const firstHit = (jsonBody(req)!.value as { hits: { title: string; author: string }[] }).hits[0]!;
    for (const leaked of [firstHit.title, firstHit.author, "minWordSizefor1Typo", "HeadlessChrome"]) expect(text).not.toContain(leaked);
    expect(text).toContain("candidateEndpoints");
    expect(text).not.toMatch(/x-algolia-api-key=(?!REDACTED)/);
  });

  it("written reports carry no header values from the capture", async () => {
    for (const name of ["hackerone", "twitch", "airbnb"] as const) {
      const report = await buildReport(site(name));
      const md = renderMarkdown(report);
      const csrf = site(name).requests.flatMap((r) => Object.values(r.requestHeaders)).filter((v) => /^[A-Za-z0-9+/=_-]{32,}$/.test(v));
      for (const value of csrf) expect(md).not.toContain(value);
    }
  });
});

// A logged-out capture of a public site cannot contain known secrets, so the
// token formats themselves are checked directly.
describe("token-shaped text", () => {
  it("redacts JWTs, bearer tokens, Google keys and key=value secrets", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const text = redactText(`Authorization: Bearer abcdef123456789 jwt=${jwt} key AIzaSyA1234567890abcdefghijklmnopqrstuv "password": "hunter2"`);
    expect(text).not.toMatch(/abcdef123456789|eyJhbGci|AIzaSy|hunter2/);
  });
});
