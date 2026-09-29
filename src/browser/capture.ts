import { chromium, type BrowserContext, type Page, type Request } from "playwright";
import type { Capture, CapturedRequest, CookieInfo, DomInfo, Phase } from "../schemas/capture.js";
import { redactBody, redactHeaders, redactUrl } from "../utils/redact.js";
import { ignoreReason, shouldKeepBody } from "./filters.js";

const MAX_BODY_BYTES = 3_000_000;
const MAX_POST_DATA = 20_000;
const MAX_TEXT = 1_000_000;

export interface CaptureOptions {
  url: string;
  interactive: boolean;
  timeoutMs: number;
  /** Extra quiet time after the load settles, to catch late fetches. */
  settleMs: number;
  /** Interactive mode: resolves when the user is done browsing. Receives the page (used by tests). */
  waitForUser?: (page: Page) => Promise<void>;
  /** Override headless (defaults to headless unless interactive). */
  headless?: boolean;
  onStatus?: (message: string) => void;
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

/**
 * Loads a page in Chromium and records its data-relevant network traffic.
 * Listeners are attached before navigation so nothing from the initial load is missed.
 */
export async function captureSite(opts: CaptureOptions): Promise<Capture> {
  const started = Date.now();
  const errors: string[] = [];
  const browser = await chromium.launch({ headless: opts.headless ?? !opts.interactive });
  const context = await browser.newContext(opts.interactive ? { viewport: null } : { viewport: { width: 1366, height: 900 } });

  let phase: Phase = "initial";
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
      phase,
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

  const page = await context.newPage();
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
  let cookies = toCookieInfo(await context.cookies().catch(() => []));

  const interactionLines = new Set<string>();
  if (opts.interactive) {
    phase = "interaction";
    opts.onStatus?.("Browser is open. Browse normally: search, filter, scroll, paginate, log in.");
    const collect = async () => {
      for (const p of context.pages()) {
        const s = await snapshot(p).catch(() => undefined);
        if (!s) continue;
        if (s.hasPasswordField) snap.hasPasswordField = true;
        if (s.hasLoadMoreButton) snap.hasLoadMoreButton = true;
        snap.paginationLinks = [...new Set([...snap.paginationLinks, ...s.paginationLinks])].slice(0, 30);
        for (const line of s.text.split("\n")) if (interactionLines.size < 20_000 && line.trim()) interactionLines.add(line.trim());
      }
      const latest = await context.cookies().catch(() => undefined);
      if (latest) cookies = toCookieInfo(latest);
    };
    const timer = setInterval(() => void collect(), 3_000);
    const closed = new Promise<void>((resolve) => {
      browser.on("disconnected", () => resolve());
      context.on("page", (p) => p.on("close", () => context.pages().length === 0 && resolve()));
      page.on("close", () => context.pages().length === 0 && resolve());
    });
    await Promise.race([opts.waitForUser?.(page) ?? new Promise<void>(() => undefined), closed]);
    clearInterval(timer);
    if (browser.isConnected()) await collect();
  }

  // Let in-flight body reads finish (bounded).
  const deadline = Date.now() + 5_000;
  while (pending.size && Date.now() < deadline) {
    await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 500))]);
  }
  await browser.close().catch(() => undefined);

  return {
    target: opts.url,
    finalUrl: redactUrl(finalUrl || opts.url),
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    interactive: opts.interactive,
    document: { status: documentStatus, headers: documentHeaders, redirectChain },
    initialHtml,
    renderedHtml,
    renderedText: snap.text.slice(0, MAX_TEXT),
    interactionText: [...interactionLines].join("\n").slice(0, MAX_TEXT),
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
