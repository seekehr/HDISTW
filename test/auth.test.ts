import { describe, expect, it } from "vitest";
import { analyzeCapture } from "../src/analyzers/index.js";
import { loginReason } from "../src/inspect.js";
import { site } from "./sites.js";

const auth = (name: Parameters<typeof site>[0]) => analyzeCapture(site(name)).auth;

describe("authentication metadata (real sites)", () => {
  it("crates.io: public data, nothing to report", () => {
    const a = auth("crates");
    expect(a).toMatchObject({ authRequired: "no", mechanisms: [], browserNeededForLogin: "no", botProtection: [] });
  });

  it("Hashnode: anonymous session cookies do not mean a login is required", () => {
    const a = auth("hashnode");
    expect(a.mechanisms).toContain("Session cookie");
    expect(a.authRequired).toBe("no");
    expect(a.notes.join(" ")).toMatch(/anonymous session cookies/);
  });

  it("nextjs.org: a 401 from a session probe on a public page is not a login wall", () => {
    const a = auth("nextjs-org");
    expect(a.deniedResponses).toContainEqual({ url: "/api/get-session", status: 401 });
    expect(a.authRequired).toBe("no");
    expect(a.notes.join(" ")).toMatch(/page content loaded without logging in/);
  });

  it("HackerOne: CSRF header detected by name, value never kept", () => {
    const a = auth("hackerone");
    expect(a.csrfHeaders).toContain("x-csrf-token");
    expect(a.mechanisms).toContain("CSRF token header");
    const sent = site("hackerone").requests.map((r) => r.requestHeaders["x-csrf-token"]).filter(Boolean);
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent)).toEqual(new Set(["[REDACTED]"]));
  });

  it("Twitch: public client-id header is reported as an API key header", () => {
    expect(auth("twitch").apiKeyHeaders).toContain("client-id");
  });

  it("GitHub: redirect to a login form means login is required", () => {
    const a = auth("github-settings");
    expect(a.authRequired).toBe("yes");
    expect(a.loginRedirect).toMatch(/^https:\/\/github\.com\/login\?return_to=/);
    expect(a.mechanisms).toEqual(expect.arrayContaining(["Login redirect", "Login form (password field)"]));
    expect(a.browserNeededForLogin).toBe("yes");
    expect(loginReason(site("github-settings"))).toMatch(/login page/);
  });

  it("detects bot protection vendors from real cookies and headers", () => {
    expect(auth("airbnb").botProtection).toContain("DataDome");
    expect(auth("hn-algolia").botProtection).toContain("Cloudflare bot management");
    expect(auth("cf-challenge").botProtection).toContain("Cloudflare challenge");
  });

  it("public pages need no login window", () => {
    for (const name of ["crates", "books-toscrape", "hashnode", "bbc-news"] as const) expect(loginReason(site(name))).toBeUndefined();
  });
});
