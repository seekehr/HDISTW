import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureSite } from "../src/browser/capture.js";
import { buildReport, loginReason } from "../src/inspect.js";
import { writeReport } from "../src/reports/write.js";
import { startFixtureServer } from "./fixtures/server.js";

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe.skipIf(!hasChromium)("end-to-end against a local fixture site", () => {
  let srv: Awaited<ReturnType<typeof startFixtureServer>>;
  beforeAll(async () => {
    srv = await startFixtureServer();
  });
  afterAll(async () => {
    await srv?.close();
  });

  const inspect = async (p: string, extra: Partial<Parameters<typeof captureSite>[0]> = {}) => {
    const cap = await captureSite({ url: `${srv.url}${p}`, timeoutMs: 15_000, settleMs: 300, ...extra });
    return { cap, report: await buildReport(cap) };
  };

  it("client-rendered SPA -> direct REST API", async () => {
    const { cap, report } = await inspect("/spa");
    expect(cap.initialHtml).toContain("Loading");
    expect(cap.renderedText).toContain("Fixture Lamp 1");
    expect(report.findings.rendering.type).toBe("API-driven");
    expect(report.recommendation).toMatchObject({ strategy: "rest-api", source: "GET /api/products", browserRequired: "no" });
  });

  it("GraphQL page -> GraphQL", async () => {
    const { report } = await inspect("/graphql-page");
    expect(report.findings.graphql[0]).toMatchObject({ operationName: "SearchLamps", entityType: "Lamp" });
    expect(report.recommendation.strategy).toBe("graphql");
  });

  it("Next.js page -> Next.js data, report files written", async () => {
    const { cap, report } = await inspect("/next");
    expect(report.findings.framework.name).toBe("Next.js");
    expect(report.recommendation.strategy).toBe("nextjs-data");
    const dir = await mkdtemp(path.join(tmpdir(), "hdistw-"));
    try {
      const written = await writeReport(report, cap, dir);
      const md = await readFile(written.markdownPath, "utf8");
      for (const heading of ["# HowDoIScrapeThisWebsite Report", "## Summary", "## Network Findings", "## Best Data Source", "## Pagination", "## Authentication", "## Alternative Strategies", "## Recommended Extraction Strategy", "## TypeScript Example", "## Uncertainties"]) {
        expect(md).toContain(heading);
      }
      const json = JSON.parse(await readFile(written.jsonPath, "utf8"));
      expect(json.recommendation.strategy).toBe("nextjs-data");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("bot check -> blocked, no recommendation", async () => {
    const { report } = await inspect("/guarded");
    expect(report.outcome).toBe("blocked");
    expect(report.recommendation.strategy).toBeNull();
  });

  it("bot check -> login window -> user passes it -> real page analyzed", async () => {
    const { cap: first } = await inspect("/guarded");
    expect(loginReason(first)).toMatch(/bot check/);
    const { cap, report } = await inspect("/guarded", {
      login: { headless: true, waitForUser: (page) => page.click("#pass").then(() => page.waitForSelector("text=Fixture Lamp 1")).then(() => undefined) },
    });
    expect(cap.usedLoginWindow).toBe(true);
    expect(report.outcome).toBe("analyzed");
    expect(report.recommendation).toMatchObject({ strategy: "rest-api", source: "GET /api/products" });
  });

  it("login redirect -> login window; the profile keeps the login for the next run", async () => {
    const profileDir = await mkdtemp(path.join(tmpdir(), "hdistw-profile-"));
    try {
      const { cap: first, report: firstReport } = await inspect("/account", { profileDir });
      expect(firstReport.findings.auth.authRequired).toBe("yes");
      expect(loginReason(first)).toMatch(/login page/);

      const signIn = async (page: Page) => {
        await page.click("#signin");
        await page.waitForSelector("text=Fixture Lamp 1");
      };
      const { report } = await inspect("/account", { profileDir, login: { headless: true, waitForUser: signIn } });
      expect(report.recommendation).toMatchObject({ strategy: "rest-api", source: "GET /api/products" });

      // No login window this time: the saved profile is already logged in.
      const { cap: later } = await inspect("/account", { profileDir });
      expect(loginReason(later)).toBeUndefined();
      expect(later.renderedText).toContain("Fixture Lamp 1");
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  it("public page -> no login window needed", async () => {
    const { cap } = await inspect("/spa");
    expect(loginReason(cap)).toBeUndefined();
  });
});
