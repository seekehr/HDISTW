/** Resource types that never carry page data worth analyzing. */
const IGNORED_RESOURCE_TYPES = new Set(["image", "font", "media", "stylesheet", "manifest", "texttrack", "ping", "beacon"]);

const ANALYTICS_HOSTS = [
  "google-analytics.com",
  "analytics.google.com",
  "googletagmanager.com",
  "googleadservices.com",
  "googlesyndication.com",
  "doubleclick.net",
  "connect.facebook.net",
  "segment.io",
  "segment.com",
  "mixpanel.com",
  "hotjar.com",
  "hotjar.io",
  "sentry.io",
  "browser-intake-datadoghq.com",
  "datadoghq-browser-agent.com",
  "nr-data.net",
  "newrelic.com",
  "clarity.ms",
  "amplitude.com",
  "fullstory.com",
  "optimizely.com",
  "analytics.tiktok.com",
  "bat.bing.com",
  "px.ads.linkedin.com",
  "snap.licdn.com",
  "hs-analytics.net",
  "cloudflareinsights.com",
  "plausible.io",
  "heapanalytics.com",
  "quantserve.com",
  "scorecardresearch.com",
  "adservice.google.com",
  "stats.g.doubleclick.net",
  "onetrust.com",
  "cookielaw.org",
];

const ANALYTICS_PATHS = /\/(collect|g\/collect|j\/collect|beacon|pixel|telemetry|log_event|__imp_apg__)(\/|\?|$)/i;

const ASSET_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|m4a|css)(\?|$)/i;

export type IgnoreReason = "asset" | "analytics" | "non-http";

export function ignoreReason(url: string, resourceType: string): IgnoreReason | undefined {
  if (!/^https?:/i.test(url)) return "non-http";
  if (IGNORED_RESOURCE_TYPES.has(resourceType)) return "asset";
  const { hostname, pathname } = new URL(url);
  const host = hostname.toLowerCase();
  if (ANALYTICS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return "analytics";
  if (ANALYTICS_PATHS.test(pathname)) return "analytics";
  if (ASSET_EXTENSIONS.test(pathname)) return "asset";
  return undefined;
}

/** Whether a response body is worth keeping in memory for analysis. */
export function shouldKeepBody(resourceType: string, contentType: string, url: string, isMainDocument: boolean): boolean {
  if (isMainDocument) return true;
  if (/json|graphql|x-component/i.test(contentType)) return true;
  if ((resourceType === "fetch" || resourceType === "xhr") && /text\/plain|javascript/i.test(contentType)) return true;
  if (resourceType === "document" && /text\/html/i.test(contentType)) return false;
  return /\/_next\/data\//.test(url);
}
