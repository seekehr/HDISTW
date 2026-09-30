/**
 * Records real websites as Capture fixtures for the unit tests.
 *
 *   npx tsx scripts/record-sites.ts            # record every site in test/sites.ts
 *   npx tsx scripts/record-sites.ts hn-algolia # record some of them
 *
 * Each site is loaded with the same Chrome capture the CLI uses, in a fresh
 * throwaway profile (never your own logins), and saved gzipped to
 * test/fixtures/sites/<name>.json.gz. Tests replay these offline.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { captureSite } from "../src/browser/capture.js";
import { buildReport } from "../src/inspect.js";
import { FIXTURE_DIR, SITES } from "../test/sites.js";

const only = process.argv.slice(2);
const sites = only.length ? SITES.filter((s) => only.includes(s.name)) : SITES;
if (only.length && sites.length !== only.length) {
  console.error(`Unknown site(s). Known: ${SITES.map((s) => s.name).join(", ")}`);
  process.exit(1);
}

await mkdir(FIXTURE_DIR, { recursive: true });
for (const site of sites) {
  const profileDir = await mkdtemp(path.join(tmpdir(), "hdistw-record-"));
  try {
    const capture = await captureSite({ url: site.url, profileDir, channel: "chrome", timeoutMs: 45_000, settleMs: 3_000 });
    const file = path.join(FIXTURE_DIR, `${site.name}.json.gz`);
    await writeFile(file, gzipSync(JSON.stringify({ recordedAt: new Date().toISOString(), capture })));
    const r = await buildReport(capture);
    console.log(
      `${site.name.padEnd(16)} ${String(capture.document.status).padEnd(4)} ${r.outcome.padEnd(9)} ${String(r.recommendation.strategy).padEnd(18)} ${r.findings.rendering.type.padEnd(22)} ${r.recommendation.source}`,
    );
  } catch (err) {
    console.log(`${site.name.padEnd(16)} FAILED ${(err as Error).message.split("\n")[0]}`);
  } finally {
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
