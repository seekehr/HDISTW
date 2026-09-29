const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24,})$/i;

export function safeUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** Groups requests to the same endpoint: method + origin + path with ID-like segments collapsed. */
export function endpointKey(method: string, url: string): string {
  const u = safeUrl(url);
  if (!u) return `${method} ${url}`;
  const path = u.pathname
    .split("/")
    .map((s) => (ID_SEGMENT.test(s) ? ":id" : s))
    .join("/");
  return `${method.toUpperCase()} ${u.origin}${path}`;
}

/** `GET /api/products?page=1` when same-origin as the page, otherwise the full URL. */
export function displayRequest(method: string, url: string, pageUrl: string): string {
  return `${method.toUpperCase()} ${shortUrl(url, pageUrl)}`;
}

export function shortUrl(url: string, pageUrl: string, maxLength = 140): string {
  const u = safeUrl(url);
  const page = safeUrl(pageUrl);
  let out = url;
  if (u && page && u.origin === page.origin) out = `${u.pathname}${u.search}`;
  return out.length > maxLength ? `${out.slice(0, maxLength - 1)}…` : out;
}

/** Path without query string, e.g. for comparing endpoints. */
export function urlWithoutQuery(url: string): string {
  const u = safeUrl(url);
  return u ? `${u.origin}${u.pathname}` : url.split("?")[0] ?? url;
}

export function queryParams(url: string): Record<string, string> {
  const u = safeUrl(url);
  if (!u) return {};
  return Object.fromEntries(u.searchParams.entries());
}

export function hostnameOf(url: string): string {
  return safeUrl(url)?.hostname ?? "unknown-host";
}
