import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureSite } from "../src/browser/capture.js";
import { buildReport } from "../src/inspect.js";
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
    const cap = await captureSite({ url: `${srv.url}${p}`, interactive: false, timeoutMs: 15_000, settleMs: 300, ...extra });
    return { cap, report: await buildReport(cap) };
  };

  it("client-rendered SPA -> direct REST API", async () => {
    const { cap, report } = await inspect("/spa");
    expect(cap.initialHtml).toContain("Loading");
    expect(cap.renderedText).toContain("Fixture Lamp 1");
    expect(report.findings.rendering.type).toBe("API-driven");
    expect(report.recommendation).toMatchObject({ strategy: "rest-api", source: "GET /api/products", browserRequired: "no" });
  });

  it("interactive mode separates interaction traffic and confirms cursor pagination", async () => {
    const { cap, report } = await inspect("/spa", {
      interactive: true,
      headless: true,
      waitForUser: async (page) => {
        for (let i = 0; i < 2; i++) {
          await page.click("#more");
          await page.waitForTimeout(400);
        }
      },
    });
    expect(cap.requests.filter((r) => r.phase === "interaction" && r.url.includes("/api/products"))).toHaveLength(2);
    expect(report.findings.pagination[0]).toMatchObject({ type: "cursor", requestParams: ["cursor"], confirmed: true });
    expect(report.codeExample).toContain('url.searchParams.set("cursor", cursor)');
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

  it("login redirect -> authentication required", async () => {
    const { report } = await inspect("/account");
    expect(report.findings.auth.authRequired).toBe("yes");
    expect(report.findings.auth.browserNeededForLogin).toBe("yes");
  });
});
