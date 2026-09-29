import { describe, expect, it } from "vitest";
import { analyzeCapture } from "../src/analyzers/index.js";
import { capture, jsonReq, PRODUCTS, VISIBLE_PRODUCTS_TEXT } from "./helpers.js";

const cookie = (name: string) => ({ name, domain: "shop.test", path: "/", httpOnly: true, secure: true, sameSite: "Lax", session: true });

describe("authentication metadata", () => {
  it("reports nothing for anonymous public data", () => {
    const a = analyzeCapture(capture({ requests: [jsonReq("https://shop.test/api/products", { data: PRODUCTS })], renderedText: VISIBLE_PRODUCTS_TEXT })).auth;
    expect(a.authRequired).toBe("no");
    expect(a.mechanisms).toEqual([]);
    expect(a.browserNeededForLogin).toBe("no");
  });

  it("treats anonymous session cookies as not requiring login", () => {
    const a = analyzeCapture(
      capture({
        cookies: [cookie("PHPSESSID"), cookie("_ga")],
        requests: [jsonReq("https://shop.test/api/products", { data: PRODUCTS }, { requestHeaders: { cookie: "[REDACTED]: 2 cookies" } })],
        renderedText: VISIBLE_PRODUCTS_TEXT,
      }),
    ).auth;
    expect(a.mechanisms).toEqual(["Session cookie"]);
    expect(a.sessionCookies.map((c) => c.name)).toEqual(["PHPSESSID"]);
    expect(a.authRequired).toBe("no");
    expect(a.notes.join(" ")).toMatch(/anonymous session cookies/);
  });

  it("detects bearer tokens and CSRF headers without exposing values", () => {
    const f = analyzeCapture(
      capture({
        requests: [
          jsonReq("https://shop.test/api/orders", { orders: PRODUCTS }, {
            requestHeaders: { authorization: "Bearer [REDACTED]", "x-csrf-token": "[REDACTED]" },
          }),
        ],
        renderedText: VISIBLE_PRODUCTS_TEXT,
      }),
    );
    const a = f.auth;
    expect(a.mechanisms).toEqual(expect.arrayContaining(["Bearer token (Authorization header)", "CSRF token header"]));
    expect(a.authorizationSchemes[0]).toEqual({ scheme: "Bearer", endpoints: ["/api/orders"] });
    expect(a.authRequired).toBe("likely");
    expect(a.browserNeededAfterLogin).toBe("probably not");
    expect(JSON.stringify(a)).not.toMatch(/eyJ|secret/);
  });

  it("detects login redirects and login forms", () => {
    const a = analyzeCapture(
      capture({
        target: "https://shop.test/account",
        finalUrl: "https://shop.test/login?next=%2Faccount",
        document: { status: 200, headers: {}, redirectChain: ["https://shop.test/account"] },
        dom: { title: "Sign in", hasPasswordField: true, paginationLinks: [], hasLoadMoreButton: false },
      }),
    ).auth;
    expect(a.authRequired).toBe("yes");
    expect(a.loginRedirect).toBe("https://shop.test/login?next=%2Faccount");
    expect(a.mechanisms).toEqual(expect.arrayContaining(["Login redirect", "Login form (password field)"]));
    expect(a.browserNeededForLogin).toBe("yes");
  });

  it("detects 401/403 data responses and bot protection", () => {
    const a = analyzeCapture(
      capture({
        cookies: [cookie("cf_clearance")],
        requests: [jsonReq("https://shop.test/api/private", { error: "unauthorized" }, { status: 401 })],
      }),
    ).auth;
    expect(a.deniedResponses).toEqual([{ url: "/api/private", status: 401 }]);
    expect(a.authRequired).toBe("likely");
    expect(a.botProtection).toContain("Cloudflare bot management");
  });
});
