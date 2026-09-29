import { describe, expect, it } from "vitest";
import { buildSanitizedSummary } from "../src/ai/sanitize.js";
import { analyzeCapture } from "../src/analyzers/index.js";
import { buildRecommendation } from "../src/scoring/recommendation.js";
import { rankStrategies } from "../src/scoring/strategies.js";
import { redactBody, redactHeaders, redactText, redactUrl } from "../src/utils/redact.js";
import { capture, jsonReq, PRODUCTS, VISIBLE_PRODUCTS_TEXT } from "./helpers.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

describe("secret redaction", () => {
  it("redacts sensitive headers but keeps the auth scheme and cookie count", () => {
    const h = redactHeaders({
      Authorization: `Bearer ${JWT}`,
      Cookie: "sid=abc; theme=dark",
      "X-CSRF-Token": "tok",
      "X-Api-Key": "k-123",
      "Set-Cookie": "sid=abc; HttpOnly",
      "Content-Type": "application/json",
    });
    expect(h).toEqual({
      authorization: "Bearer [REDACTED]",
      cookie: "[REDACTED]: 2 cookies",
      "x-csrf-token": "[REDACTED]",
      "x-api-key": "[REDACTED]",
      "set-cookie": "[REDACTED]",
      "content-type": "application/json",
    });
  });

  it("redacts sensitive query params and URL credentials, keeps pagination tokens", () => {
    const u = redactUrl("https://user:pw@api.test/v1/items?api_key=SECRET&access_token=T&page=2&nextToken=abc");
    expect(u).not.toMatch(/SECRET|user:pw|=T&/);
    expect(u).toContain("page=2");
    expect(u).toContain("nextToken=abc");
  });

  it("redacts request bodies by key (JSON, form, GraphQL variables)", () => {
    expect(JSON.parse(redactBody('{"email":"a@b.c","password":"hunter2","variables":{"token":"t1","first":5}}'))).toEqual({
      email: "a@b.c",
      password: "[REDACTED]",
      variables: { token: "[REDACTED]", first: 5 },
    });
    expect(redactBody("username=bob&password=hunter2", "application/x-www-form-urlencoded")).toBe("username=bob&password=REDACTED");
  });

  it("redacts token-shaped text", () => {
    const text = redactText(`Authorization: Bearer abcdef123456789 jwt=${JWT} key AIzaSyA1234567890abcdefghijklmnopqrstuv "password": "hunter2"`);
    expect(text).not.toMatch(/abcdef123456789|eyJhbGci|AIzaSy|hunter2/);
  });

  it("never sends cookies, tokens or bodies to Gemini", () => {
    const cap = capture({
      renderedText: VISIBLE_PRODUCTS_TEXT,
      cookies: [{ name: "session_id", domain: "shop.test", path: "/", httpOnly: true, secure: true, session: true }],
      requests: [
        jsonReq(`https://shop.test/api/products?api_key=SECRET123`, { data: PRODUCTS, apiToken: JWT }, {
          requestHeaders: redactHeaders({ authorization: `Bearer ${JWT}`, cookie: "session_id=s3cr3tv4lue" }),
          postData: redactBody(JSON.stringify({ password: "hunter2" })),
        }),
      ],
    });
    const f = analyzeCapture(cap);
    const strategies = rankStrategies(f);
    const { summary } = buildSanitizedSummary(cap, f, strategies, buildRecommendation(cap, f, strategies));
    const text = JSON.stringify(summary);
    for (const secret of ["SECRET123", "eyJhbGci", "s3cr3tv4lue", "hunter2", "Ergonomic Widget"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("candidateEndpoints");
  });
});
