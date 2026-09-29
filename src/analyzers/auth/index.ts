import type { AuthFinding, EmbeddedState, GraphQLOperation, RestCandidate } from "../../schemas/findings.js";
import { shortUrl } from "../../utils/url.js";
import type { AnalysisContext } from "../context.js";

const SESSION_COOKIE =
  /(sess|^sid$|_sid$|auth|token|jwt|login|remember|connect\.sid|phpsessid|jsessionid|asp\.net_sessionid|^_session|_session$|^user_?id$|logged_?in)/i;
const NON_AUTH_COOKIE = /^(_ga|_gid|_gat|_gcl|_fbp|_fbc|_hj|_clck|_clsk|ajs_|amplitude|mp_|optimizely|OptanonConsent|cookieconsent)/i;
const BOT_COOKIES: [RegExp, string][] = [
  [/^cf_clearance$|^__cf_bm$/, "Cloudflare bot management"],
  [/^_px/, "PerimeterX / HUMAN"],
  [/^datadome$/, "DataDome"],
  [/^_abck$|^bm_sz$/, "Akamai Bot Manager"],
  [/^incap_ses|^visid_incap/, "Imperva / Incapsula"],
];
const CSRF_HEADER = /^(x-)?(csrf|xsrf)[-_]?token$|^x-csrftoken$|^x-xsrf-token$/i;
const API_KEY_HEADER = /^(x-)?(api[-_]?key|goog-api-key|app[-_]?key|client[-_]?id)$/i;
const LOGIN_PATH = /\/(login|log-in|signin|sign-in|sign_in|auth|authenticate|sso|oauth|account\/login|users\/sign_in)(\/|\?|$)/i;

export function analyzeAuth(
  ctx: AnalysisContext,
  rest: RestCandidate[],
  graphql: GraphQLOperation[],
  embedded: EmbeddedState[],
): AuthFinding {
  const { capture, pageUrl } = ctx;
  const mechanisms: string[] = [];
  const notes: string[] = [];

  const sessionCookies = capture.cookies
    .filter((c) => SESSION_COOKIE.test(c.name) && !NON_AUTH_COOKIE.test(c.name))
    .map((c) => ({ name: c.name, domain: c.domain, httpOnly: c.httpOnly }));
  if (sessionCookies.length) mechanisms.push("Session cookie");

  const schemes = new Map<string, Set<string>>();
  const csrf = new Set<string>();
  const apiKeys = new Set<string>();
  for (const req of capture.requests) {
    const auth = req.requestHeaders["authorization"];
    if (auth) {
      const scheme = auth.split(" ")[0] ?? "unknown";
      if (!schemes.has(scheme)) schemes.set(scheme, new Set());
      schemes.get(scheme)?.add(shortUrl(req.url.split("?")[0] ?? req.url, pageUrl));
    }
    for (const name of Object.keys(req.requestHeaders)) {
      if (CSRF_HEADER.test(name)) csrf.add(name);
      if (API_KEY_HEADER.test(name)) apiKeys.add(name);
    }
  }
  const authorizationSchemes = [...schemes.entries()].map(([scheme, eps]) => ({ scheme, endpoints: [...eps].slice(0, 5) }));
  for (const { scheme } of authorizationSchemes) mechanisms.push(`${scheme} token (Authorization header)`);
  if (csrf.size) mechanisms.push("CSRF token header");
  if (apiKeys.size) mechanisms.push("API key header");

  const deniedResponses = capture.requests
    .filter((r) => r.status === 401 || r.status === 403)
    .map((r) => ({ url: shortUrl(r.url, pageUrl), status: r.status as number }))
    .slice(0, 10);

  const chain = [...capture.document.redirectChain, capture.finalUrl];
  const loginRedirect = chain.slice(1).find((u) => LOGIN_PATH.test(new URL(u, pageUrl).pathname + new URL(u, pageUrl).search));
  const targetIsLogin = LOGIN_PATH.test(new URL(capture.target).pathname);
  const redirectedToLogin = !!loginRedirect && !targetIsLogin;
  const loginFormDetected = capture.dom.hasPasswordField;
  if (redirectedToLogin) mechanisms.push("Login redirect");
  if (loginFormDetected) mechanisms.push("Login form (password field)");

  const botProtection = new Set<string>();
  for (const c of capture.cookies) for (const [re, label] of BOT_COOKIES) if (re.test(c.name)) botProtection.add(label);
  const allHeaders = [capture.document.headers, ...capture.requests.map((r) => r.responseHeaders)];
  if (allHeaders.some((h) => h["cf-mitigated"] === "challenge")) botProtection.add("Cloudflare challenge");
  if (allHeaders.some((h) => "x-datadome" in h || "x-dd-b" in h)) botProtection.add("DataDome");
  if (/just a moment|attention required|are you a robot|verify you are human|captcha/i.test(capture.dom.title + " " + capture.renderedText.slice(0, 2000)))
    botProtection.add("challenge / CAPTCHA page shown");

  const dataSources = [...rest, ...graphql].filter((s) => s.score >= 50);
  const deniedDocument = capture.document.status === 401 || capture.document.status === 403;
  // A 401 from a session probe is normal on public pages; only count it when the page itself is thin.
  const pageHasContent =
    embedded.some((e) => e.canReplaceDom) || capture.renderedText.split(/\s+/).filter(Boolean).length >= 80;
  const deniedData = deniedResponses.length > 0 && dataSources.length === 0 && !pageHasContent;
  if (deniedResponses.length && !deniedData && pageHasContent)
    notes.push("Some requests returned 401/403 (e.g. session or account probes), but the page content loaded without logging in.");
  const dataNeedsAuth = dataSources.some((s) => s.sentAuthorization);

  let authRequired: AuthFinding["authRequired"] = "no";
  if (redirectedToLogin || (deniedDocument && !botProtection.size)) authRequired = "yes";
  else if (deniedData || dataNeedsAuth || (loginFormDetected && dataSources.length === 0 && !embedded.some((e) => e.canReplaceDom)))
    authRequired = "likely";

  if (redirectedToLogin) notes.push(`Redirected to a login page (${shortUrl(loginRedirect as string, pageUrl)}).`);
  if (dataNeedsAuth) notes.push("Candidate data requests carry an Authorization header; the token must be obtained and reused.");
  if (sessionCookies.length && authRequired === "no")
    notes.push("Session-like cookies are set, but data loaded without logging in; they are probably anonymous session cookies.");
  if (dataSources.some((s) => s.sentCookies))
    notes.push("Candidate data requests were sent with cookies; replay may need the same cookies if plain requests fail.");
  if (botProtection.size) notes.push("Bot protection detected. This tool does not bypass it; respect the site's terms and rate limits.");

  let browserNeededForLogin: AuthFinding["browserNeededForLogin"] = "no";
  let browserNeededAfterLogin: AuthFinding["browserNeededAfterLogin"] = "no";
  if (authRequired !== "no") {
    browserNeededForLogin = loginFormDetected || redirectedToLogin ? "yes" : "unknown";
    const reusable = dataSources.length > 0 || embedded.some((e) => e.canReplaceDom);
    browserNeededAfterLogin = reusable ? "probably not" : "unknown";
  }

  return {
    mechanisms,
    sessionCookies: sessionCookies.slice(0, 10),
    authorizationSchemes,
    csrfHeaders: [...csrf],
    apiKeyHeaders: [...apiKeys],
    deniedResponses,
    loginRedirect: redirectedToLogin ? loginRedirect : undefined,
    loginFormDetected,
    botProtection: [...botProtection],
    authRequired,
    browserNeededForLogin,
    browserNeededAfterLogin,
    notes,
  };
}
