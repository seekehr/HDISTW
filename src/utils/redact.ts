/**
 * Secret redaction. Applied at capture time to headers, URLs and request
 * bodies, and again (defence in depth) to anything sent to Gemini or written
 * to reports.
 */

export const REDACTED = "[REDACTED]";

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-xsrf-token",
  "csrf-token",
  "x-csrftoken",
  "x-amz-security-token",
  "x-goog-api-key",
]);
const SENSITIVE_HEADER_PATTERN = /(token|secret|auth|session|api[-_]?key|signature|csrf|xsrf|password|credential)/i;

/** Pagination tokens are opaque but not secrets; keeping them lets us confirm pagination. */
const PAGINATION_KEYS = new Set([
  "nexttoken",
  "pagetoken",
  "nextpagetoken",
  "continuationtoken",
  "cursortoken",
  "prevtoken",
  "previoustoken",
]);

const SENSITIVE_KEY_SUFFIXES = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "apikey",
  "authorization",
  "cookie",
  "sessionid",
  "csrf",
  "xsrf",
  "credential",
  "credentials",
  "otp",
  "cvv",
  "cvc",
  "cardnumber",
  "signature",
];
const SENSITIVE_KEYS_EXACT = new Set(["auth", "key", "sig", "session", "sid", "code", "pin", "ssn"]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_.\s]/g, "");
}

export function isSensitiveKey(key: string): boolean {
  const k = normalizeKey(key);
  if (PAGINATION_KEYS.has(k)) return false;
  if (SENSITIVE_KEYS_EXACT.has(k)) return true;
  return SENSITIVE_KEY_SUFFIXES.some((s) => k.endsWith(s));
}

export function isSensitiveHeader(name: string): boolean {
  const n = name.toLowerCase();
  return SENSITIVE_HEADER_NAMES.has(n) || SENSITIVE_HEADER_PATTERN.test(n);
}

/** Redacts header values, keeping only enough to reason about them (auth scheme, cookie count). */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (name === "authorization" || name === "proxy-authorization") {
      const scheme = /^\s*([A-Za-z-]+)\s+\S/.exec(value)?.[1];
      out[name] = scheme ? `${scheme} ${REDACTED}` : REDACTED;
    } else if (name === "cookie") {
      const count = value.split(";").filter((p) => p.trim()).length;
      out[name] = `${REDACTED}: ${count} cookie${count === 1 ? "" : "s"}`;
    } else if (isSensitiveHeader(name)) {
      out[name] = REDACTED;
    } else {
      out[name] = value;
    }
  }
  return out;
}

/** Removes credentials and sensitive query parameter values from a URL. */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return redactText(url);
  }
  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (isSensitiveKey(key)) parsed.searchParams.set(key, "REDACTED");
  }
  return parsed.toString();
}

/** Deeply redacts values under sensitive keys. */
export function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 30) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactJson(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) && v !== null && typeof v !== "object" ? REDACTED : redactJson(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return redactText(value);
  return value;
}

/** Redacts a request body based on its content type. */
export function redactBody(body: string, contentType = ""): string {
  const trimmed = body.trim();
  if (contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(redactJson(JSON.parse(trimmed)));
    } catch {
      // fall through
    }
  }
  if (contentType.includes("x-www-form-urlencoded") || /^[\w.%-]+=[^&]*(&[\w.%-]+=[^&]*)*$/.test(trimmed)) {
    const params = new URLSearchParams(trimmed);
    for (const key of [...params.keys()]) {
      if (isSensitiveKey(key)) params.set(key, "REDACTED");
    }
    return params.toString();
  }
  if (/pass(word)?|secret|token/i.test(trimmed)) return REDACTED;
  return redactText(trimmed);
}

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const BEARER_PATTERN = /\b(Bearer|Basic|Token)\s+(?!\[REDACTED\])[A-Za-z0-9\-._~+/]{8,}=*/g;
const KEY_VALUE_PATTERN =
  /(["']?(?:access_?token|refresh_?token|id_?token|api_?key|apikey|client_?secret|password|passwd|secret|session_?id)["']?\s*[:=]\s*["']?)([^"'\s&,;}]{4,})/gi;
const GOOGLE_KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{35}\b/g;
const AWS_KEY_PATTERN = /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g;

/** Redacts token-shaped substrings in free text. */
export function redactText(text: string): string {
  return text
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(BEARER_PATTERN, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(KEY_VALUE_PATTERN, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(GOOGLE_KEY_PATTERN, REDACTED)
    .replace(AWS_KEY_PATTERN, REDACTED);
}
