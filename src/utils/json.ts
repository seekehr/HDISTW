import type { CapturedRequest } from "../schemas/capture.js";

const cache = new WeakMap<CapturedRequest, { value: unknown } | null>();

export function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return /json|graphql|javascript-json|\+json/i.test(contentType);
}

/** Parses JSON text, tolerating common XSSI prefixes like `)]}'` and `for(;;);`. */
export function parseJsonText(text: string): { value: unknown } | null {
  const cleaned = text.replace(/^\s*(\)\]\}'?,?|for\s*\(\s*;\s*;\s*\)\s*;|while\s*\(\s*1\s*\)\s*;)\s*/, "").trim();
  if (!cleaned || !/^[[{"]/.test(cleaned)) return null;
  try {
    return { value: JSON.parse(cleaned) };
  } catch {
    return null;
  }
}

/** The parsed JSON body of a captured response, or null if it is not JSON. Memoized. */
export function jsonBody(req: CapturedRequest): { value: unknown } | null {
  if (cache.has(req)) return cache.get(req) ?? null;
  const parsed = req.bodyText !== undefined && !req.bodyTruncated ? parseJsonText(req.bodyText) : null;
  cache.set(req, parsed);
  return parsed;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Compact, value-free description of a JSON shape, e.g.
 * `{ data: { products: [{ id: number, title: string }] (24) }, meta: { nextCursor: string } }`.
 */
export function summarizeSchema(value: unknown, maxDepth = 4, maxKeys = 12): string {
  const walk = (v: unknown, depth: number): string => {
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      if (depth >= maxDepth) return `[…] (${v.length})`;
      const firstObj = v.find((x) => x !== null && typeof x === "object") ?? v[0];
      return `[${walk(firstObj, depth + 1)}] (${v.length})`;
    }
    if (isPlainObject(v)) {
      const keys = Object.keys(v);
      if (keys.length === 0) return "{}";
      if (depth >= maxDepth) return `{…${keys.length} keys}`;
      const shown = keys.slice(0, maxKeys).map((k) => `${k}: ${walk(v[k], depth + 1)}`);
      if (keys.length > maxKeys) shown.push(`…+${keys.length - maxKeys}`);
      return `{ ${shown.join(", ")} }`;
    }
    return typeName(v);
  };
  return walk(value, 0);
}

/** Reads a dotted path (with `[]` meaning "first element") from a value. */
export function getPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const part of path.split(".")) {
    const isArray = part.endsWith("[]");
    const key = isArray ? part.slice(0, -2) : part;
    if (key) {
      if (!isPlainObject(cur)) return undefined;
      cur = cur[key];
    }
    if (isArray) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[0];
    }
  }
  return cur;
}

/** Top-level keys with a short preview, useful for reporting. */
export function topKeys(value: unknown, max = 15): string[] {
  return isPlainObject(value) ? Object.keys(value).slice(0, max) : [];
}

/** Approximate byte size of a string. */
export function byteSize(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
