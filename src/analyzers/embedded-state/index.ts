import type { EmbeddedState } from "../../schemas/findings.js";
import { byteSize, isPlainObject, parseJsonText } from "../../utils/json.js";
import { clampScore, type AnalysisContext } from "../context.js";
import { assessPayload } from "../payload.js";

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const ASSIGNMENT =
  /(?:(?:window|self|globalThis)\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*["']([^"']+)["']\s*\])|(?:var|let|const)\s+([A-Za-z_$][\w$]*))\s*=\s*/g;
const STATE_NAME = /state|data|props|store|apollo|preloaded|initial|hydrat|bootstrap|context|payload|^__[A-Za-z0-9_]+__$/i;
const IGNORED_NAMES = /^(dataLayer|_gaq|gtag|ga|fbq|__cfRLUnblockHandlers|__NEXT_DATA__|__next_f|google_tag_data)$/i;
const CONTENT_JSONLD_TYPES =
  /^(Product|ItemList|Offer|AggregateOffer|Recipe|JobPosting|Event|Article|NewsArticle|BlogPosting|Review|Book|Movie|Course|LocalBusiness|Place|RealEstateListing|SearchResultsPage|CollectionPage|VideoObject|Question|FAQPage)$/;

function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(attrs)?.[1];
}

/** Extracts a balanced `{...}` or `[...]` literal starting at `start`, honoring strings. */
export function extractBalanced(src: string, start: number): string | undefined {
  const open = src[start];
  if (open !== "{" && open !== "[") return undefined;
  let depth = 0;
  let quote: string | undefined;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Handles `JSON.parse("...")` / `JSON.parse('...')` assignments. */
function extractJsonParseLiteral(src: string, start: number): string | undefined {
  const m = /^JSON\.parse\(\s*(["'])/.exec(src.slice(start, start + 20));
  if (!m) return undefined;
  const quote = m[1] as string;
  const from = start + m[0].length;
  let i = from;
  for (; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === quote) break;
  }
  const body = src.slice(from, i);
  try {
    const asDouble = quote === '"' ? body : body.replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"');
    return JSON.parse(`"${asDouble}"`) as string;
  } catch {
    return undefined;
  }
}

function jsonLdTypes(value: unknown): string[] {
  const types = new Set<string>();
  const visit = (v: unknown, depth: number) => {
    if (depth > 4) return;
    if (Array.isArray(v)) v.forEach((x) => visit(x, depth + 1));
    else if (isPlainObject(v)) {
      const t = v["@type"];
      if (typeof t === "string") types.add(t);
      if (Array.isArray(t)) t.filter((x) => typeof x === "string").forEach((x) => types.add(x));
      if (v["@graph"]) visit(v["@graph"], depth + 1);
      if (v.itemListElement) visit(v.itemListElement, depth + 1);
    }
  };
  visit(value, 0);
  return [...types];
}

interface RawBlock {
  name: string;
  kind: EmbeddedState["kind"];
  locator: string;
  text: string;
}

function findBlocks(html: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  let jsonLdIndex = 0;
  let jsonIndex = 0;
  for (const match of html.matchAll(SCRIPT_TAG)) {
    const attrs = match[1] ?? "";
    const body = (match[2] ?? "").trim();
    if (!body) continue;
    const type = (attr(attrs, "type") ?? "").toLowerCase();
    const id = attr(attrs, "id");
    if (type === "application/ld+json") {
      jsonLdIndex++;
      blocks.push({ name: `JSON-LD #${jsonLdIndex}`, kind: "json-ld", locator: `script[type="application/ld+json"] (#${jsonLdIndex})`, text: body });
    } else if (/json/.test(type)) {
      if (id === "__NEXT_DATA__") continue; // Reported by the Next.js analyzer.
      jsonIndex++;
      const locator = id ? `script#${id}` : `script[type="${type}"] (#${jsonIndex})`;
      blocks.push({ name: id ?? `JSON script #${jsonIndex}`, kind: "json-script", locator, text: body });
    } else if (!type || /javascript|module/.test(type)) {
      for (const m of body.matchAll(ASSIGNMENT)) {
        const name = m[1] ?? m[2] ?? m[3] ?? "";
        if (!STATE_NAME.test(name) || IGNORED_NAMES.test(name)) continue;
        const valueStart = (m.index ?? 0) + m[0].length;
        const literal = extractBalanced(body, valueStart) ?? extractJsonParseLiteral(body, valueStart);
        if (!literal || literal.length < 40) continue;
        blocks.push({ name, kind: "window-assignment", locator: `window.${name}`, text: literal });
      }
    }
  }
  return blocks;
}

/** Finds structured state serialized into the served HTML (JSON-LD, JSON scripts, window.__STATE__). */
export function analyzeEmbeddedState(ctx: AnalysisContext): EmbeddedState[] {
  const html = ctx.capture.initialHtml || ctx.capture.renderedHtml;
  const results: EmbeddedState[] = [];
  for (const block of findBlocks(html)) {
    const parsed = parseJsonText(block.text);
    const sizeBytes = byteSize(block.text);
    if (!parsed) {
      results.push({
        name: block.name,
        kind: block.kind === "window-assignment" ? "serialized-js" : block.kind,
        locator: block.locator,
        sizeBytes,
        parseable: false,
        canReplaceDom: false,
        score: sizeBytes > 2000 ? 15 : 5,
        reasons: ["serialized JavaScript, not strict JSON (needs a JS-aware parser)"],
      });
      continue;
    }
    const assessment = assessPayload(parsed.value, ctx.visible);
    const reasons = ["parseable JSON in served HTML (no JavaScript needed)", ...assessment.reasons];
    let score = assessment.score + 15;
    let types: string[] | undefined;
    let contentJsonLd = false;
    if (block.kind === "json-ld") {
      types = jsonLdTypes(parsed.value);
      contentJsonLd = types.some((t) => CONTENT_JSONLD_TYPES.test(t));
      if (contentJsonLd) {
        score += 10;
        reasons.push(`schema.org content types: ${types.join(", ")}`);
      } else {
        score -= 10;
        reasons.push(`schema.org metadata only (${types.join(", ") || "untyped"})`);
      }
    }
    if (sizeBytes < 200 && !assessment.recordSet) score -= 10;
    const canReplaceDom =
      (!!assessment.recordSet && assessment.visibleOverlap >= 0.5 && assessment.score >= 35) ||
      (contentJsonLd && assessment.visibleOverlap >= 0.4);
    if (canReplaceDom) reasons.push("contains the visible page data; can replace DOM scraping");
    results.push({
      name: block.name,
      kind: block.kind,
      locator: block.locator,
      sizeBytes,
      parseable: true,
      jsonLdTypes: types,
      canReplaceDom,
      score: clampScore(score),
      reasons,
      assessment,
    });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 15);
}
