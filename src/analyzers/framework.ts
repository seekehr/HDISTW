import type { Capture } from "../schemas/capture.js";
import type { FrameworkFinding } from "../schemas/findings.js";

interface Signature {
  name: string;
  html?: RegExp[];
  urls?: RegExp[];
  headers?: [string, RegExp][];
}

// Ordered by specificity: meta-frameworks before the UI libraries they build on.
const SIGNATURES: Signature[] = [
  {
    name: "Next.js",
    html: [/id=["']__NEXT_DATA__["']/, /\/_next\/static\//, /self\.__next_f/],
    urls: [/\/_next\//],
    headers: [["x-powered-by", /next\.js/i], ["x-nextjs-cache", /./], ["x-nextjs-prerender", /./]],
  },
  { name: "Nuxt", html: [/window\.__NUXT__/, /id=["']__NUXT_DATA__["']/, /\/_nuxt\//], urls: [/\/_nuxt\//] },
  { name: "Remix", html: [/window\.__remixContext/, /__remixManifest/] },
  { name: "Gatsby", html: [/id=["']___gatsby["']/], urls: [/\/page-data\/.*\.json/] },
  { name: "SvelteKit", html: [/__sveltekit_/, /\/_app\/immutable\//], urls: [/\/_app\/immutable\//, /__data\.json/] },
  { name: "Astro", html: [/<astro-island\b/, /\/_astro\//] },
  { name: "Angular", html: [/\bng-version=/, /\bng-app\b/] },
  { name: "Shopify", html: [/cdn\.shopify\.com/, /Shopify\.theme/] },
  { name: "WordPress", html: [/\/wp-content\//, /\/wp-json\//], urls: [/\/wp-json\//] },
  { name: "React", html: [/data-reactroot/, /__REACT_DEVTOOLS/, /react-dom/] },
  { name: "Vue", html: [/\bdata-v-[0-9a-f]{6,}/, /__vue_app__/, /\bv-cloak\b/] },
];

export function detectFramework(capture: Capture): FrameworkFinding {
  const html = `${capture.initialHtml}\n${capture.renderedHtml}`;
  const detected: FrameworkFinding["detected"] = [];
  for (const sig of SIGNATURES) {
    const signals: string[] = [];
    for (const re of sig.html ?? []) if (re.test(html)) signals.push(`HTML matches ${re.source}`);
    for (const re of sig.urls ?? []) {
      const hit = capture.requests.find((r) => re.test(r.url));
      if (hit) signals.push(`request to ${new URL(hit.url).pathname}`);
    }
    const headerSources = [capture.document.headers, ...capture.requests.map((r) => r.responseHeaders)];
    for (const [name, re] of sig.headers ?? []) {
      if (headerSources.some((h) => h[name] !== undefined && re.test(h[name] ?? ""))) signals.push(`${name} header`);
    }
    if (signals.length) detected.push({ name: sig.name, signals: [...new Set(signals)].slice(0, 4) });
  }
  return { name: detected[0]?.name ?? "none detected", detected };
}
