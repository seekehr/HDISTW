const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    const lower = code.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return ENTITIES[lower] ?? m;
  });
}

/** Rough visible text of an HTML string: drops scripts, styles and tags. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td|\/th|\/a|\/span|\/button)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /\w/.test(w)).length;
}

/** A normalized blob of visible text for substring checks. */
export class VisibleText {
  readonly normalized: string;

  constructor(...texts: string[]) {
    this.normalized = normalizeText(texts.join("\n"));
  }

  contains(value: string): boolean {
    const n = normalizeText(value);
    return n.length >= 3 && this.normalized.includes(n);
  }

  get isEmpty(): boolean {
    return this.normalized.length === 0;
  }
}

/**
 * Fraction of distinct meaningful lines in `rendered` that also appear in `initial`.
 * Used to tell server-rendered content apart from content that appears only after JavaScript.
 */
export function textCoverage(rendered: string, initial: string, maxLines = 400): number {
  const lines = [
    ...new Set(
      rendered
        .split("\n")
        .map((l) => normalizeText(l))
        .filter((l) => l.length >= 4 && /[a-z]/.test(l)),
    ),
  ].slice(0, maxLines);
  if (lines.length === 0) return initial.trim() ? 1 : 0;
  const haystack = normalizeText(initial);
  const found = lines.filter((l) => haystack.includes(l)).length;
  return found / lines.length;
}
