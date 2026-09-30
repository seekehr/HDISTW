import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { Capture } from "../src/schemas/capture.js";

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "sites");

/**
 * Real public pages the unit tests replay. Each was picked for how it loads its
 * data; the comment says what it exercises. Re-record with scripts/record-sites.ts.
 */
export const SITES = [
  // Server-rendered HTML with page links.
  { name: "books-toscrape", url: "https://books.toscrape.com/" },
  { name: "quotes-ssr", url: "https://quotes.toscrape.com/" },
  // `var data = [...]` in an inline script.
  { name: "quotes-js", url: "https://quotes.toscrape.com/js/" },
  // Infinite scroll over GET /api/quotes?page=N.
  { name: "quotes-scroll", url: "https://quotes.toscrape.com/scroll" },
  // Algolia POST search with page/hitsPerPage in the body and an API key in the URL.
  { name: "hn-algolia", url: "https://hn.algolia.com/?query=typescript" },
  // SSR (Vue) with ItemList JSON-LD.
  { name: "anilist", url: "https://anilist.co/search/anime/trending" },
  // CloudFront plain "403 Forbidden".
  { name: "imdb-top", url: "https://www.imdb.com/chart/top/" },
  // Next.js App Router (RSC) with a 401 session probe.
  { name: "nextjs-org", url: "https://nextjs.org/showcase" },
  // Cloudflare managed challenge (a practice page built for this).
  { name: "cf-challenge", url: "https://www.scrapingcourse.com/cloudflare-challenge" },
  // Redirect to a login form.
  { name: "github-settings", url: "https://github.com/settings/profile" },
  // "Prove your humanity" interstitial served with HTTP 200.
  { name: "reddit-json", url: "https://www.reddit.com/r/programming/" },
  // Cloudflare HTTP 402 access block.
  { name: "allrecipes", url: "https://www.allrecipes.com/recipe/10813/best-chocolate-chip-cookies/" },
  // Batched persisted-query GraphQL (gql.twitch.tv) plus lots of third-party JSON.
  { name: "twitch", url: "https://www.twitch.tv/directory" },
  // JSON script state, persisted GET GraphQL, DataDome, CSRF header.
  { name: "airbnb", url: "https://www.airbnb.com/s/Lisbon/homes" },
  // SPA over GET /api/v1/crates?page=N&per_page=N.
  { name: "crates", url: "https://crates.io/crates?sort=downloads" },
  // Next.js App Router + REST + JSON-LD (content and metadata).
  { name: "hashnode", url: "https://hashnode.com/" },
  // Next.js Pages Router: __NEXT_DATA__ with getServerSideProps.
  { name: "bbc-news", url: "https://www.bbc.com/news" },
  // GraphQL with query text and offset/cursor pagination, CSRF header.
  { name: "hackerone", url: "https://hackerone.com/hacktivity/overview" },
  // GraphQL gateway plus window.__APOLLO_STATE__.
  { name: "coursera", url: "https://www.coursera.org/search?query=python" },
] as const;

export type SiteName = (typeof SITES)[number]["name"];

const cache = new Map<SiteName, Capture>();

/** A recorded real-site capture. Record with `npx tsx scripts/record-sites.ts <name>`. */
export function site(name: SiteName): Capture {
  const hit = cache.get(name);
  if (hit) return structuredClone(hit);
  const raw = readFileSync(path.join(FIXTURE_DIR, `${name}.json.gz`));
  const { capture } = JSON.parse(gunzipSync(raw).toString("utf8")) as { capture: Capture };
  cache.set(name, capture);
  return structuredClone(capture);
}

