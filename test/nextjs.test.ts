import { describe, expect, it } from "vitest";
import { buildContext } from "../src/analyzers/context.js";
import { detectFramework } from "../src/analyzers/framework.js";
import { analyzeNextjs, extractNextData } from "../src/analyzers/nextjs/index.js";
import { findRecordSets } from "../src/analyzers/payload.js";
import { site } from "./sites.js";

const next = (name: Parameters<typeof site>[0]) => analyzeNextjs(buildContext(site(name)));

describe("Next.js detection (real sites)", () => {
  it("BBC News: Pages Router with __NEXT_DATA__ and getServerSideProps", () => {
    const raw = extractNextData(site("bbc-news").initialHtml);
    const f = next("bbc-news");
    expect(f).toMatchObject({ detected: true, router: "pages", page: "/[[...slug]]", buildId: raw?.value.buildId });
    expect(f.dataFetching).toContain("getServerSideProps");
    expect(f.signals).toEqual(expect.arrayContaining(["__NEXT_DATA__ script", "/_next/static assets"]));
    expect(f.nextData?.pagePropsKeys).toEqual(expect.arrayContaining(["page", "navigation", "metadata"]));
    expect(f.nextData?.assessment.visibleOverlap).toBeGreaterThanOrEqual(0.5);
  });

  it("BBC News: picks the visible story list, not the larger footer language list", () => {
    const pageProps = (extractNextData(site("bbc-news").initialHtml)!.value.props as { pageProps: unknown }).pageProps;
    const [heaviest] = findRecordSets(pageProps);
    expect(heaviest?.path).toBe("navigation.footer.languages");
    const chosen = next("bbc-news").nextData?.assessment.recordSet;
    expect(chosen?.path).toMatch(/\.sections\[\]\.content$/);
    expect(chosen?.signals).toEqual(expect.arrayContaining(["title", "url"]));
  });

  it("BBC News: derives (but labels) the /_next/data URL since none was observed", () => {
    const f = next("bbc-news");
    expect(f.dataRequests).toEqual([]);
    expect(f.derivedDataUrl).toBe(`https://www.bbc.com/_next/data/${f.buildId}/news.json`);
  });

  it("nextjs.org: App Router with RSC flight data and _rsc requests", () => {
    const f = next("nextjs-org");
    expect(f).toMatchObject({ detected: true, router: "app", flightDataInHtml: true, nextData: undefined, derivedDataUrl: undefined });
    expect(f.rscRequests.length).toBeGreaterThan(0);
    expect(f.rscRequests.every((r) => r.url.includes("_rsc="))).toBe(true);
    expect(f.dataFetching).toEqual(["React Server Components"]);
  });

  it("Hashnode: App Router identified by x-powered-by", () => {
    const f = next("hashnode");
    expect(f.router).toBe("app");
    expect(f.signals).toContain("x-powered-by: Next.js");
  });

  it("does not report Next.js on other sites", () => {
    for (const name of ["books-toscrape", "crates", "anilist", "hackerone"] as const) expect(next(name).detected).toBe(false);
  });
});

describe("framework detection (real sites)", () => {
  it("names the framework each site is built with", () => {
    expect(detectFramework(site("bbc-news")).name).toBe("Next.js");
    expect(detectFramework(site("nextjs-org")).name).toBe("Next.js");
    expect(detectFramework(site("anilist")).name).toBe("Vue");
    expect(detectFramework(site("github-settings")).name).toBe("React");
    expect(detectFramework(site("books-toscrape")).name).toBe("none detected");
  });
});
