#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { Command, InvalidArgumentError } from "commander";
import { z } from "zod";
import { captureSite } from "../browser/capture.js";
import { buildReport, geminiFromEnv, VERSION } from "../inspect.js";
import { writeReport } from "../reports/write.js";
import { bold, dim, fail, ok, renderSummary } from "./output.js";

const UrlSchema = z
  .string()
  .transform((s) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`))
  .pipe(z.url({ protocol: /^https?$/ }));

function parseUrl(value: string): string {
  const result = UrlSchema.safeParse(value);
  if (!result.success) throw new InvalidArgumentError("Expected an http(s) URL.");
  return result.data;
}

function parseMs(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError("Expected a number of milliseconds.");
  return n;
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const done = () => {
      rl.close();
      process.off("SIGINT", done);
      resolve();
    };
    rl.question(`${dim("Press Enter here when you are done browsing (or close the browser).")}\n`, done);
    process.once("SIGINT", done);
  });
}

function loadDotEnv(): void {
  if (existsSync(".env")) {
    try {
      process.loadEnvFile(".env");
    } catch {
      // ignore malformed .env
    }
  }
}

const program = new Command()
  .name("hdistw")
  .description("HowDoIScrapeThisWebsite: find out how a website loads its data and how to scrape it efficiently.")
  .version(VERSION);

program
  .command("inspect")
  .description("Load a URL in Chromium, analyze its network traffic and recommend an extraction strategy.")
  .argument("<url>", "page to inspect", parseUrl)
  .option("-i, --interactive", "open a visible browser and keep recording while you browse", false)
  .option("-o, --out <dir>", "report output directory", "reports")
  .option("--timeout <ms>", "navigation timeout", parseMs, 45_000)
  .option("--settle <ms>", "extra wait after the page settles", parseMs, 2_000)
  .option("--no-ai", "skip Gemini and use the deterministic recommendation only")
  .option("--model <name>", "Gemini model (default: $GEMINI_MODEL or gemini-flash-latest)")
  .action(async (url: string, opts: { interactive: boolean; out: string; timeout: number; settle: number; ai: boolean; model?: string }) => {
    loadDotEnv();
    console.log(bold("HowDoIScrapeThisWebsite"), "\n");
    console.log(`Target: ${url}\n`);

    const capture = await captureSite({
      url,
      interactive: opts.interactive,
      timeoutMs: opts.timeout,
      settleMs: opts.settle,
      waitForUser: opts.interactive ? waitForEnter : undefined,
      onStatus: (msg) => console.log(ok(msg)),
    });
    if (!capture.initialHtml && !capture.renderedHtml) {
      console.error(fail("Could not load the page."));
      for (const e of capture.errors) console.error(dim(`  ${e}`));
      process.exitCode = 1;
      return;
    }

    const gemini = opts.ai ? geminiFromEnv(opts.model) : { client: undefined, reason: "AI disabled with --no-ai." };
    const report = await buildReport(capture, { gemini: gemini.client, aiDisabledReason: gemini.reason });
    const written = await writeReport(report, capture, opts.out);
    console.log(renderSummary(report, written.markdownPath));
  });

program.parseAsync().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    console.error(fail("Chromium is not installed. Run: npx playwright install chromium"));
  } else {
    console.error(fail(message));
  }
  process.exit(1);
});
