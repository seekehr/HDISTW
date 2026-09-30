import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Request } from "playwright";
import type { Capture, CapturedRequest, CookieInfo, DomInfo } from "../schemas/capture.js";
import { redactBody, redactHeaders, redactUrl } from "../utils/redact.js";
import { ignoreReason, shouldKeepBody } from "./filters.js";

const MAX_BODY_BYTES = 3_000_000;
const MAX_POST_DATA = 20_000;
const MAX_TEXT = 1_000_000;

export interface CaptureOptions {
  url: string;
  timeoutMs: number;
  /** Extra quiet time after the load settles, to catch late fetches. */
  settleMs: number;
  /** Persistent browser profile directory, so logins survive between runs. */
  profileDir?: string;
  /** "chrome" to launch the real Chrome binary via CDP (no automation flags). Omit for Playwright's Chromium. */
  channel?: string;
  /**
   * Open a visible window first so the user can log in or pass a bot check.
   * The page is then reloaded in that session and captured.
   */
  login?: {
    /** Resolves when the user is done. Receives the page (used by tests). */
    waitForUser: (page: Page) => Promise<void>;
    /** Tests only: run the "window" headless. */
    headless?: boolean;
  };
}

interface Snapshot extends DomInfo {
  text: string;
}

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const pagePattern = /[?&](page|p|pg|offset|start)=\d+|\/page[-/]\d+/i;
    const nextText = /^\s*(next|next page|older|›|»|→)\s*[›»→]?\s*$/i;
    const relNext = [...document.querySelectorAll<HTMLAnchorElement | HTMLLinkElement>("a[rel~=next], link[rel~=next]")].map(
      (a) => a.href,
    );
    const numbered = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
      .filter((a) => pagePattern.test(a.href) || nextText.test(a.textContent ?? ""))
      .map((a) => a.href);
    const loadMore = [...document.querySelectorAll("button, a, [role=button]")].some((b) =>
      /^\s*(load|show|view|see) more\b|more results/i.test(b.textContent ?? ""),
    );
    return {
      title: document.title,
      text: document.body?.innerText ?? "",
      hasPasswordField: !!document.querySelector("input[type=password]"),
      paginationLinks: [...new Set([...relNext, ...numbered])].slice(0, 20),
      hasLoadMoreButton: loadMore,
    };
  });
}

function toCookieInfo(cookies: Awaited<ReturnType<BrowserContext["cookies"]>>): CookieInfo[] {
  return cookies.map((c) => ({
    name: c.name,
    domain: c.domain,
    path: c.path,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
    session: c.expires === -1,
  }));
}

function isMainFrameNavigation(req: Request): boolean {
  try {
    return req.isNavigationRequest() && req.frame().parentFrame() === null;
  } catch {
    return false;
  }
}

/** Shows the page in a visible window and waits until the user has logged in / passed the check. */
async function waitForLogin(context: BrowserContext, opts: CaptureOptions, login: NonNullable<CaptureOptions["login"]>) {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs }).catch(() => undefined);
  let closed = false;
  const windowClosed = new Promise<void>((resolve) => {
    context.on("close", () => ((closed = true), resolve()));
    page.on("close", () => {
      if (context.pages().length === 0) (closed = true), resolve();
    });
  });
  await Promise.race([login.waitForUser(page), windowClosed]);
  if (closed || context.pages().length === 0) throw new Error("The browser window was closed before the page was captured.");
}

// --- Chrome via CDP (no Playwright automation flags) ---

function findChrome(): string {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    for (const env of ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] as const) {
      const base = process.env[env];
      if (base) candidates.push(path.join(base, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser");
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error("Chrome not found. Install Google Chrome.");
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chrome did not start within ${timeoutMs}ms.`);
}

interface ChromeHandle {
  browser: Browser;
  context: BrowserContext;
  proc: ChildProcess;
}

async function launchChrome(opts: CaptureOptions): Promise<ChromeHandle> {
  const exe = findChrome();
  const port = await freePort();
  const headless = opts.login ? (opts.login.headless ?? false) : true;

  const args = [
    `--remote-debugging-port=${port}`,
    ...(opts.profileDir ? [`--user-data-dir=${opts.profileDir}`] : []),
    ...(headless ? ["--headless=new"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];

  const proc = spawn(exe, args, { stdio: "pipe" });

  // If Chrome exits immediately, surface the error.
  const exitPromise = new Promise<never>((_, reject) => {
    proc.on("exit", (code) => reject(new Error(`Chrome exited with code ${code}`)));
  });

  try {
    await Promise.race([waitForCdp(port, 15_000), exitPromise]);
  } catch (err) {
    proc.kill();
    throw err;
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0] ?? await browser.newContext();

  return { browser, context, proc };
}

// --- Playwright Chromium (for tests and fallback) ---

interface PlaywrightHandle {
  browser?: Browser;
  context: BrowserContext;
}

async function launchPlaywright(opts: CaptureOptions): Promise<PlaywrightHandle> {
  const headless = opts.login ? (opts.login.headless ?? false) : true;
  const viewport = headless ? { width: 1366, height: 900 } : null;
  if (opts.profileDir) {
    const context = await chromium.launchPersistentContext(opts.profileDir, { headless, viewport });
    return { context };
  }
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport });
  return { browser, context };
}

// --- Public API ---

export async function captureSite(opts: CaptureOptions): Promise<Capture> {
  if (opts.channel === "chrome") {
    const handle = await launchChrome(opts);
    try {
      if (opts.login) await waitForLogin(handle.context, opts, opts.login);
      return await recordLoad(handle.context, opts);
    } finally {
      await handle.context.close().catch(() => undefined);
      await handle.browser.close().catch(() => undefined);
      handle.proc.kill();
    }
  }

  const handle = await launchPlaywright(opts);
  try {
    if (opts.login) await waitForLogin(handle.context, opts, opts.login);
    return await recordLoad(handle.context, opts);
  } finally {
    await handle.context.close().catch(() => undefined);
    await handle.browser?.close().catch(() => undefined);
  }
}

async function recordLoad(context: BrowserContext, opts: CaptureOptions): Promise<Capture> {
  const started = Date.now();
  const errors: string[] = [];
  let nextId = 1;
  const entries = new Map<Request, CapturedRequest>();
  const pending = new Set<Promise<void>>();
  const ignored = { total: 0, byReason: {} as Record<string, number> };
  const track = (p: Promise<void>) => {
    const tracked = p.catch(() => undefined).finally(() => pending.delete(tracked));
    pending.add(tracked);
  };

  context.on("request", (req) => {
    const reason = ignoreReason(req.url(), req.resourceType());
    if (reason) {
      ignored.total++;
      ignored.byReason[reason] = (ignored.byReason[reason] ?? 0) + 1;
      return;
    }
    const entry: CapturedRequest = {
      id: nextId++,
      url: redactUrl(req.url()),
      method: req.method(),
      resourceType: req.resourceType(),
      requestHeaders: {},
      responseHeaders: {},
      isNavigation: isMainFrameNavigation(req),
      startedAt: Date.now() - started,
    };
    entries.set(req, entry);
    track(
      req.allHeaders().then((headers) => {
        entry.requestHeaders = redactHeaders(headers);
        const post = req.postData();
        if (post) entry.postData = redactBody(post.slice(0, MAX_POST_DATA), headers["content-type"]);
      }),
    );
  });

  context.on("requestfinished", (req) => {
    const entry = entries.get(req);
    if (!entry) return;
    track(
      (async () => {
        const res = await req.response();
        if (!res) return;
        entry.status = res.status();
        const headers = await res.allHeaders();
        entry.responseHeaders = redactHeaders(headers);
        entry.contentType = headers["content-type"];
        const length = Number(headers["content-length"]);
        if (Number.isFinite(length)) entry.bodySize = length;
        if (res.status() >= 300 && res.status() < 400) return;
        if (!shouldKeepBody(entry.resourceType, entry.contentType ?? "", entry.url, entry.isNavigation)) return;
        const body = await res.body();
        entry.bodySize = body.length;
        entry.bodyTruncated = body.length > MAX_BODY_BYTES;
        entry.bodyText = body.subarray(0, MAX_BODY_BYTES).toString("utf8");
      })(),
    );
  });

  context.on("requestfailed", (req) => {
    const entry = entries.get(req);
    if (entry) entry.failure = req.failure()?.errorText ?? "failed";
  });

  const page = context.pages()[0] ?? (await context.newPage());
  let initialHtml = "";
  let documentStatus: number | undefined;
  let documentHeaders: Record<string, string> = {};
  const redirectChain: string[] = [];

  try {
    const response = await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs });
    if (response) {
      documentStatus = response.status();
      documentHeaders = redactHeaders(await response.allHeaders());
      for (let r = response.request().redirectedFrom(); r; r = r.redirectedFrom()) redirectChain.unshift(redactUrl(r.url()));
      try {
        initialHtml = await response.text();
      } catch (err) {
        errors.push(`Could not read the served HTML: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    errors.push(`Navigation failed: ${(err as Error).message.split("\n")[0]}`);
  }

  await page.waitForLoadState("networkidle", { timeout: Math.min(opts.timeoutMs, 15_000) }).catch(() => {
    errors.push("Network never went idle; some late requests may be missing.");
  });
  await page.waitForTimeout(opts.settleMs);

  let snap: Snapshot = { title: "", text: "", hasPasswordField: false, paginationLinks: [], hasLoadMoreButton: false };
  let renderedHtml = "";
  try {
    snap = await snapshot(page);
    renderedHtml = await page.content();
  } catch (err) {
    errors.push(`Could not read the rendered DOM: ${(err as Error).message.split("\n")[0]}`);
  }
  const finalUrl = page.url();
  const cookies = toCookieInfo(await context.cookies().catch(() => []));

  // Let in-flight body reads finish (bounded).
  const deadline = Date.now() + 5_000;
  while (pending.size && Date.now() < deadline) {
    await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 500))]);
  }

  return {
    target: opts.url,
    finalUrl: redactUrl(finalUrl || opts.url),
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    usedLoginWindow: !!opts.login,
    document: { status: documentStatus, headers: documentHeaders, redirectChain },
    initialHtml,
    renderedHtml,
    renderedText: snap.text.slice(0, MAX_TEXT),
    dom: {
      title: snap.title,
      hasPasswordField: snap.hasPasswordField,
      paginationLinks: snap.paginationLinks.map(redactUrl),
      hasLoadMoreButton: snap.hasLoadMoreButton,
    },
    requests: [...entries.values()].sort((a, b) => a.id - b.id),
    ignored,
    cookies,
    errors,
  };
}
