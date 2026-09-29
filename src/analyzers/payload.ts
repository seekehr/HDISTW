import type { PayloadAssessment, RecordSet } from "../schemas/findings.js";
import { isPlainObject, summarizeSchema } from "../utils/json.js";
import type { VisibleText } from "../utils/text.js";
import { STRONG_RESPONSE_KINDS, findPaginationFields } from "./pagination/vocabulary.js";

type Signal = RecordSet["signals"][number];

const SIGNAL_KEYS: Record<Signal, RegExp> = {
  id: /^(id|_id|uuid|guid|sku|slug|key|pk|[a-z]+_id|[a-z]+Id)$/,
  title: /^(title|name|label|headline|heading|display_?name|product_?name|full_?name|text|caption)$/i,
  price: /(price|amount|cost|salary|fee)/i,
  image: /(image|img|thumbnail|thumb|photo|picture|avatar|media|poster|cover)/i,
  url: /^(url|href|link|permalink|path|slug|canonical_?url|web_?url)$/i,
  date: /(date|time|created|updated|published|At$)/,
};
const IMAGE_VALUE = /\.(jpe?g|png|webp|gif|avif|svg)(\?|$)/i;

export interface FoundRecordSet extends RecordSet {
  items: Record<string, unknown>[];
  weight: number;
}

function commonKeys(items: Record<string, unknown>[]): string[] {
  const freq = new Map<string, number>();
  for (const item of items) for (const k of Object.keys(item)) freq.set(k, (freq.get(k) ?? 0) + 1);
  return [...freq.entries()].filter(([, n]) => n >= items.length * 0.5).map(([k]) => k);
}

function signalsFor(keys: string[], items: Record<string, unknown>[]): Signal[] {
  const signals = new Set<Signal>();
  for (const [signal, pattern] of Object.entries(SIGNAL_KEYS) as [Signal, RegExp][]) {
    if (keys.some((k) => pattern.test(k))) signals.add(signal);
  }
  const first = items[0] ?? {};
  for (const v of Object.values(first)) {
    if (typeof v === "string" && IMAGE_VALUE.test(v)) signals.add("image");
  }
  return [...signals];
}

function toRecordSet(path: string, elements: unknown[]): FoundRecordSet | undefined {
  const sample = elements.slice(0, 50);
  let objects = sample.filter(isPlainObject);
  if (objects.length < 2 || objects.length < sample.length * 0.8) return undefined;
  let keys = commonKeys(objects);
  // GraphQL connection edges: [{ node: {...}, cursor }] -> use the nodes.
  if (keys.includes("node") && keys.every((k) => ["node", "cursor", "__typename"].includes(k))) {
    objects = objects.map((o) => o.node).filter(isPlainObject);
    if (objects.length < 2) return undefined;
    keys = commonKeys(objects);
    path = `${path}[].node`;
  }
  if (keys.length < 2) return undefined;
  const signals = signalsFor(keys, objects);
  const weight = Math.min(elements.length, 50) * (1 + signals.length) * (Math.min(keys.length, 15) / 5);
  return { path, count: elements.length, keys: keys.slice(0, 25), signals, items: objects, weight };
}

/** Finds arrays (or ID-keyed maps) of similar objects anywhere in a JSON value, best first. */
export function findRecordSets(value: unknown): FoundRecordSet[] {
  const found: FoundRecordSet[] = [];
  let budget = 20_000;
  const walk = (v: unknown, path: string, depth: number) => {
    if (budget-- <= 0 || depth > 10) return;
    if (Array.isArray(v)) {
      const set = toRecordSet(path, v);
      if (set) found.push(set);
      for (const item of v.slice(0, 3)) walk(item, `${path}[]`, depth + 1);
      return;
    }
    if (!isPlainObject(v)) return;
    const values = Object.values(v);
    // Normalized stores (Redux entities, Apollo cache): { "Product:1": {...}, "Product:2": {...} }
    if (values.length >= 3) {
      const set = toRecordSet(path ? `${path}.*` : "*", values);
      if (set && commonKeys(set.items).length >= 3) found.push(set);
    }
    for (const [k, child] of Object.entries(v)) walk(child, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(value, "", 0);
  return found.sort((a, b) => b.weight - a.weight);
}

function candidateStrings(value: unknown, out: string[], depth = 0, limit = 40): void {
  if (out.length >= limit || depth > 3) return;
  if (typeof value === "string") {
    const s = value.trim();
    if (
      s.length >= 3 &&
      s.length <= 150 &&
      /[a-z]/i.test(s) &&
      !/^(https?:)?\//.test(s) &&
      !/^[0-9a-f-]{16,}$/i.test(s) &&
      !/^\d{4}-\d{2}-\d{2}T/.test(s)
    )
      out.push(s);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 5)) candidateStrings(v, out, depth + 1, limit);
  } else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      // Schema metadata (`@type`, `__typename`) is never page text.
      if (!k.startsWith("@") && k !== "__typename") candidateStrings(v, out, depth + 1, limit);
    }
  }
}

/** Fraction of sampled records with at least one string visible on the page. */
export function recordOverlap(items: Record<string, unknown>[], visible: VisibleText): number {
  if (visible.isEmpty) return 0;
  let considered = 0;
  let matched = 0;
  for (const item of items.slice(0, 25)) {
    const strings: string[] = [];
    candidateStrings(item, strings, 0, 12);
    if (strings.length === 0) continue;
    considered++;
    if (strings.some((s) => visible.contains(s))) matched++;
  }
  return considered ? matched / considered : 0;
}

function scalarOverlap(value: unknown, visible: VisibleText): number {
  if (visible.isEmpty) return 0;
  const strings: string[] = [];
  candidateStrings(value, strings, 0, 60);
  if (strings.length === 0) return 0;
  return strings.filter((s) => visible.contains(s)).length / strings.length;
}

/**
 * Scores how useful a JSON payload is as a scraping source (0..~70). Transport
 * signals (JSON response, fetch/XHR, /api/ path) are added by each analyzer.
 */
export function assessPayload(value: unknown, visible: VisibleText): PayloadAssessment {
  const reasons: string[] = [];
  let score = 0;
  const sets = findRecordSets(value);
  const best = sets[0];
  let visibleOverlap = 0;

  if (best) {
    score += 20;
    if (best.count >= 5) score += 5;
    reasons.push(`repeated records (${best.count} at ${best.path || "root"})`);
    const signalPoints: Record<Signal, number> = { id: 5, title: 5, price: 5, image: 3, url: 2, date: 0 };
    for (const s of best.signals) score += signalPoints[s];
    const named = best.signals.filter((s) => s !== "date");
    if (named.length) reasons.push(`record fields: ${named.join(", ")}`);
    visibleOverlap = recordOverlap(best.items, visible);
    if (visibleOverlap > 0) {
      score += Math.round(25 * visibleOverlap);
      reasons.push(`visible content matches response (${Math.round(visibleOverlap * 100)}% of sampled records)`);
    }
  } else {
    visibleOverlap = scalarOverlap(value, visible);
    if (visibleOverlap >= 0.3) {
      score += Math.round(15 * visibleOverlap);
      reasons.push(`some values visible on page (${Math.round(visibleOverlap * 100)}%)`);
    }
  }

  const pagination = findPaginationFields(value);
  const strong = pagination.filter((f) => STRONG_RESPONSE_KINDS.has(f.kind));
  if (strong.length) {
    score += 8;
    reasons.push(`pagination fields (${strong.map((f) => f.path).slice(0, 3).join(", ")})`);
  }

  return {
    score,
    reasons,
    recordSet: best
      ? { path: best.path, count: best.count, keys: best.keys, signals: best.signals }
      : undefined,
    visibleOverlap,
    paginationFields: pagination.map((f) => f.path),
    schema: summarizeSchema(value),
  };
}
