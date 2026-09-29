import type { Findings, GraphQLOperation, PaginationFinding, RestCandidate, StrategyId } from "../schemas/findings.js";
import { redactText } from "../utils/redact.js";

const IDENT = /^[A-Za-z_$][\w$]*$/;

function prop(key: string): string {
  return IDENT.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/** Turns a record-set path like `data.items` or `edges[].node` into a JS accessor on `root`. */
export function accessor(root: string, path: string | undefined): string {
  if (!path) return root;
  const [before, after] = path.split(/\[\]\.?(.*)/s);
  const access = (base: string, p: string) =>
    p
      .split(".")
      .filter(Boolean)
      .reduce((expr, seg) => (seg === "*" ? `Object.values(${expr})` : `${expr}${prop(seg)}`), base);
  const head = access(root, before ?? "");
  if (path.includes("[]") && after) return `${head}.map((item) => ${access("item", after)})`;
  return head;
}

function recordsLine(root: string, path: string | undefined, count?: number): string {
  return `const records = ${accessor(root, path)};${count ? ` // ${count} records observed` : ""}`;
}

function headersLiteral(extra: Record<string, string>, comments: string[] = []): string {
  const lines = Object.entries(extra).map(([k, v]) => `    ${JSON.stringify(k)}: ${v},`);
  return `{\n${[...comments.map((c) => `    // ${c}`), ...lines].join("\n")}\n  }`;
}

function restExample(c: RestCandidate, p: PaginationFinding | undefined, withSession: boolean): string {
  const headers: Record<string, string> = { accept: '"application/json"' };
  const comments: string[] = [];
  if (c.sentAuthorization || withSession) {
    if (c.sentAuthorization) headers.authorization = "process.env.API_AUTHORIZATION!";
    if (withSession) headers.cookie = "cookieHeader";
    comments.push("Session values come from your own logged-in session. Never hard-code them.");
  }
  const path = c.assessment.recordSet?.path;
  const pageParam = p?.requestParams.find((x) => /^(page|p|pg|pagenumber|pageno)$/i.test(x));
  const offsetParam = p?.requestParams.find((x) => /^(offset|skip|start)$/i.test(x));
  const cursorParam = p?.requestParams.find((x) => /cursor|after|token|continuation/i.test(x));
  const cursorField = p?.responseFields.find((x) => /cursor|token|continuation/i.test(x.split(".").pop() ?? ""));
  const hasBody = c.method !== "GET" && c.requestBody;

  const fetchCall = (urlExpr: string) =>
    `await fetch(${urlExpr}, {\n  ${hasBody ? `method: ${JSON.stringify(c.method)},\n  ` : ""}headers: ${headersLiteral(
      hasBody ? { ...headers, "content-type": '"application/json"' } : headers,
      comments,
    )},${hasBody ? `\n  body: JSON.stringify(${c.requestBody}),` : ""}\n})`;

  if (c.method === "GET" && p && (cursorParam && cursorField)) {
    return `const url = new URL(${JSON.stringify(c.url)});
let cursor: string | undefined;

do {
  if (cursor) url.searchParams.set(${JSON.stringify(cursorParam)}, cursor);
  const response = ${fetchCall("url").replace(/\n/g, "\n  ")};
  if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
  const data = await response.json();
  ${recordsLine("data", path)}
  console.log(records.length, records[0]);
  cursor = ${accessor("data", cursorField).replace(/\.(\w+)$/, "?.$1")};
  await new Promise((r) => setTimeout(r, 1000)); // be polite
} while (cursor);`;
  }
  const numeric = pageParam ?? offsetParam;
  if (c.method === "GET" && p && numeric) {
    const start = pageParam ? 1 : 0;
    const step = pageParam ? "1" : "records.length";
    return `const url = new URL(${JSON.stringify(c.url)});

for (let ${pageParam ? "page" : "offset"} = ${start}; ; ${pageParam ? "page" : "offset"} += ${step}) {
  url.searchParams.set(${JSON.stringify(numeric)}, String(${pageParam ? "page" : "offset"}));
  const response = ${fetchCall("url").replace(/\n/g, "\n  ")};
  if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
  const data = await response.json();
  ${recordsLine("data", path)}
  if (!records?.length) break;
  console.log(records.length, records[0]);
  await new Promise((r) => setTimeout(r, 1000)); // be polite
}`;
  }
  const nextHint = cursorField
    ? `\n// Next page: ${accessor("data", cursorField)}. The request parameter that takes it was not observed;\n// run hdistw with --interactive and load the next page to discover it.`
    : "";
  return `const response = ${fetchCall(JSON.stringify(c.url))};
if (!response.ok) throw new Error(\`HTTP \${response.status}\`);

const data = await response.json();
${recordsLine("data", path, c.assessment.recordSet?.count)}
console.log(records);${nextHint}`;
}

function graphqlExample(op: GraphQLOperation): string {
  const body: string[] = [];
  if (op.operationName) body.push(`    operationName: ${JSON.stringify(op.operationName)},`);
  if (op.query) body.push(`    query: \`${op.query.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\`,`);
  body.push(`    variables: ${JSON.stringify(op.variables ?? {}, null, 2).replace(/\n/g, "\n    ")},`);
  if (!op.query && op.persistedQueryHash)
    body.push(`    extensions: { persistedQuery: { version: 1, sha256Hash: ${JSON.stringify(op.persistedQueryHash)} } },`);
  const auth = op.sentAuthorization ? `\n    authorization: process.env.API_AUTHORIZATION!, // from your own session` : "";
  return `const response = await fetch(${JSON.stringify(op.endpoint)}, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json",${auth}
  },
  body: JSON.stringify({
${body.join("\n")}
  }),
});

const { data, errors } = await response.json();
if (errors?.length) throw new Error(errors[0].message);
${recordsLine("data", op.assessment.recordSet?.path.replace(/^data\.?/, ""), op.assessment.recordSet?.count)}
console.log(records);`;
}

function nextjsExample(f: Findings, pageUrl: string): string {
  const observed = [...f.nextjs.dataRequests].sort((a, b) => b.assessment.score - a.assessment.score)[0];
  const nextData = f.nextjs.nextData;
  if (observed && (!nextData || observed.assessment.score >= nextData.assessment.score)) {
    return `// Observed Next.js data endpoint. The build ID in the path changes on every deploy:
// re-read it from the page's __NEXT_DATA__ ("buildId") when requests start returning 404.
const response = await fetch(${JSON.stringify(observed.url)}, { headers: { accept: "application/json" } });
const { pageProps } = await response.json();
${recordsLine("pageProps", observed.assessment.recordSet?.path)}
console.log(records);`;
  }
  return `const html = await (await fetch(${JSON.stringify(pageUrl)})).text();

const match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\\s\\S]*?)<\\/script>/);
if (!match) throw new Error("__NEXT_DATA__ not found");

const nextData = JSON.parse(match[1]);
const pageProps = nextData.props.pageProps; // keys: ${nextData?.pagePropsKeys.slice(0, 6).join(", ") || "none"}
${recordsLine("pageProps", nextData?.assessment.recordSet?.path, nextData?.assessment.recordSet?.count)}
console.log(records);`;
}

function embeddedExample(f: Findings, pageUrl: string): string {
  const block = f.embeddedState.find((e) => e.parseable);
  if (!block) return ssrExample(pageUrl);
  const path = block.assessment?.recordSet?.path;
  const fetchHtml = `const html = await (await fetch(${JSON.stringify(pageUrl)})).text();\n`;
  if (block.kind === "window-assignment") {
    const name = block.locator.replace(/^window\./, "");
    return `${fetchHtml}
// ${block.locator} is assigned in an inline <script>. This assumes the assignment
// is the last statement in that script; adjust the end marker if needed.
const start = html.indexOf(${JSON.stringify(name)});
const jsonStart = html.slice(start).search(/[[{]/) + start;
const jsonEnd = html.indexOf("</script>", jsonStart);
const state = JSON.parse(html.slice(jsonStart, jsonEnd).trim().replace(/;$/, ""));
${recordsLine("state", path)}
console.log(records);`;
  }
  const selector =
    block.kind === "json-ld"
      ? `/<script[^>]*type="application\\/ld\\+json"[^>]*>([\\s\\S]*?)<\\/script>/g`
      : block.locator.startsWith("script#")
        ? `/<script[^>]*id="${block.locator.slice(7).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"[^>]*>([\\s\\S]*?)<\\/script>/g`
        : `/<script[^>]*type="application\\/json"[^>]*>([\\s\\S]*?)<\\/script>/g`;
  return `${fetchHtml}
const blocks = [...html.matchAll(${selector})].map((m) => JSON.parse(m[1]));
const state = blocks[0]; // ${block.name}${block.jsonLdTypes?.length ? ` (${block.jsonLdTypes.join(", ")})` : ""}
${recordsLine("state", path)}
console.log(records);`;
}

function ssrExample(pageUrl: string): string {
  return `import * as cheerio from "cheerio"; // npm i cheerio

const html = await (await fetch(${JSON.stringify(pageUrl)})).text();
const $ = cheerio.load(html);

// Replace the selector with the element that wraps each item on this page.
const items = $("SELECTOR")
  .map((_, el) => $(el).text().trim())
  .get();
console.log(items);`;
}

function playwrightExample(pageUrl: string): string {
  return `import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(${JSON.stringify(pageUrl)}, { waitUntil: "networkidle" });

// Replace the selector with the element that wraps each item on this page.
const items = await page.$$eval("SELECTOR", (els) => els.map((el) => el.textContent?.trim()));
console.log(items);

await browser.close();`;
}

function browserAuthExample(f: Findings, pageUrl: string): string {
  const rest = f.rest[0];
  const gql = f.graphql.find((o) => o.operationType !== "mutation");
  const useGql = gql && (!rest || gql.score > rest.score);
  const request = useGql && gql ? graphqlExample({ ...gql, sentAuthorization: false }) : rest ? restExample(rest, undefined, true) : "";
  return `import { chromium } from "playwright";

// 1. Log in once in a real browser window, by hand. Nothing is automated or bypassed.
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(${JSON.stringify(pageUrl)});
console.log("Log in in the browser window, then press Enter here.");
await new Promise((resolve) => process.stdin.once("data", resolve));
const cookies = await context.cookies();
await browser.close();

// 2. Reuse the session for direct HTTP requests.
const cookieHeader = cookies.map((c) => \`\${c.name}=\${c.value}\`).join("; ");
${useGql ? request.replace(`"content-type": "application/json",`, `"content-type": "application/json",\n    cookie: cookieHeader,`) : request}`;
}

/** Minimal TypeScript example for the chosen strategy. Only observed URLs are used. */
export function generateExample(
  strategy: StrategyId,
  f: Findings,
  pageUrl: string,
  pagination?: PaginationFinding,
): string {
  let code: string;
  switch (strategy) {
    case "rest-api":
      code = f.rest[0] ? restExample(f.rest[0], pagination, false) : ssrExample(pageUrl);
      break;
    case "graphql": {
      const op = f.graphql.find((o) => o.operationType !== "mutation");
      code = op ? graphqlExample(op) : ssrExample(pageUrl);
      break;
    }
    case "nextjs-data":
      code = nextjsExample(f, pageUrl);
      break;
    case "embedded-json":
      code = embeddedExample(f, pageUrl);
      break;
    case "browser-auth-http":
      code = browserAuthExample(f, pageUrl);
      break;
    case "ssr-html":
      code = ssrExample(pageUrl);
      break;
    case "playwright-dom":
      code = playwrightExample(pageUrl);
      break;
  }
  return redactText(code);
}
