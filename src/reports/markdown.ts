import { describePagination, paginationLabel } from "../scoring/recommendation.js";
import type { Report } from "../schemas/report.js";
import { redactText } from "../utils/redact.js";

const BROWSER_LABEL = { no: "No", "login-only": "Only for login", yes: "Yes" } as const;

function list(items: string[], empty = "_None._"): string {
  return items.length ? items.map((i) => `- ${i}`).join("\n") : empty;
}

function table(headers: string[], rows: string[][]): string {
  if (!rows.length) return "_None._";
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ].join("\n");
}

export function renderMarkdown(r: Report): string {
  const f = r.findings;
  const rec = r.recommendation;
  const top = r.strategies[0];
  const out: string[] = [];

  out.push("# HowDoIScrapeThisWebsite Report", "");
  out.push(`**Target:** ${r.target}  `);
  if (r.finalUrl !== r.target) out.push(`**Final URL:** ${r.finalUrl}  `);
  out.push(`**Generated:** ${r.generatedAt}${r.usedLoginWindow ? " (logged-in session)" : ""}`, "");

  if (r.outcome === "blocked") {
    out.push(
      "## Blocked",
      "",
      r.blockedReason ?? "The site served a bot check instead of the page.",
      "",
      "The real page was never loaded, so nothing behind the bot check was analyzed and there is no recommendation. hdistw does not try to get past bot checks.",
      "",
      "## What to do",
      "",
      list(rec.uncertainties),
      "",
      "## What was captured",
      "",
      `- Document status: ${r.stats.documentStatus ?? "unknown"}`,
      `- Bot protection signals: ${f.auth.botProtection.join(", ") || "none"}`,
      `- Captured requests: ${r.stats.capturedRequests}`,
      "",
    );
    return redactText(out.join("\n"));
  }

  out.push("## Summary", "");
  out.push(
    table(
      ["", ""],
      [
        ["Framework", f.framework.name],
        ["Rendering", f.rendering.type],
        ["Authentication", f.auth.mechanisms.join(", ") || "None detected"],
        ["Auth required", f.auth.authRequired],
        ["Browser required", BROWSER_LABEL[rec.browserRequired]],
        ["Best source", rec.source],
        ["Recommended", top ? top.label : (rec.strategy ?? "none")],
      ],
    ),
    "",
  );

  out.push("## Alternative Strategies", "");
  out.push(
    "Scores are fitness scores (0-100), not probabilities.",
    "",
    table(
      ["#", "Strategy", "Score", "Browser", "Source", "Why"],
      r.strategies.map((s, i) => [String(i + 1), s.label, String(s.score), BROWSER_LABEL[s.browserRequired], s.source ?? "-", s.reasons.slice(0, 3).join("; ")]),
    ),
    "",
  );

  out.push("## Network Findings", "");
  out.push(
    `- Captured requests: ${r.stats.capturedRequests} (ignored ${r.stats.ignoredRequests} assets/analytics)`,
    `- JSON responses: ${r.stats.jsonResponses}`,
    `- Served HTML contains ${Math.round(f.rendering.initialHtmlCoverage * 100)}% of the visible text`,
    "",
  );
  out.push("### Candidate endpoints", "");
  out.push(
    table(
      ["Score", "Request", "Records", "Reasons"],
      f.rest.slice(0, 10).map((c) => [
        String(c.score),
        `\`${c.display}\``,
        c.assessment.recordSet ? `${c.assessment.recordSet.count} @ \`${c.assessment.recordSet.path || "root"}\`` : "-",
        c.reasons.join("; "),
      ]),
    ),
    "",
  );
  if (f.graphql.length) {
    out.push("### GraphQL operations", "");
    out.push(
      table(
        ["Score", "Endpoint", "Operation", "Type", "Entity", "Variables", "Pagination"],
        f.graphql.slice(0, 10).map((op) => [
          String(op.score),
          `\`${op.method} ${op.endpoint}\``,
          op.operationName ?? (op.persistedQueryHash ? "persisted query" : "anonymous"),
          op.operationType,
          op.entityType ?? "-",
          Object.keys(op.variables ?? {}).join(", ") || "-",
          op.paginationFields.join(", ") || "-",
        ]),
      ),
      "",
    );
  }
  if (f.nextjs.detected) {
    out.push("### Next.js", "");
    out.push(
      `- Router: ${f.nextjs.router ?? "unknown"}`,
      `- Signals: ${f.nextjs.signals.join(", ")}`,
      ...(f.nextjs.buildId ? [`- Build ID: \`${f.nextjs.buildId}\``] : []),
      ...(f.nextjs.page ? [`- Page: \`${f.nextjs.page}\``] : []),
      ...(f.nextjs.dataFetching.length ? [`- Data fetching: ${f.nextjs.dataFetching.join(", ")}`] : []),
      ...(f.nextjs.nextData
        ? [
            `- \`__NEXT_DATA__\`: ${Math.round(f.nextjs.nextData.sizeBytes / 1024)} KB, pageProps keys: ${f.nextjs.nextData.pagePropsKeys.join(", ") || "none"}`,
            ...(f.nextjs.nextData.assessment.reasons.length ? [`  - ${f.nextjs.nextData.assessment.reasons.join("; ")}`] : []),
          ]
        : []),
      ...f.nextjs.dataRequests.map((d) => `- Observed data request: \`${d.url}\``),
      ...(f.nextjs.derivedDataUrl ? [`- Derived (not observed) data URL: \`${f.nextjs.derivedDataUrl}\``] : []),
      ...(f.nextjs.rscRequests.length ? [`- RSC requests: ${f.nextjs.rscRequests.length}`] : []),
      "",
    );
  }
  if (f.embeddedState.length) {
    out.push("### Embedded state", "");
    out.push(
      table(
        ["Score", "Locator", "Kind", "Size", "Replaces DOM?", "Notes"],
        f.embeddedState.slice(0, 10).map((e) => [
          String(e.score),
          `\`${e.locator}\``,
          e.kind,
          `${Math.max(1, Math.round(e.sizeBytes / 1024))} KB`,
          e.canReplaceDom ? "yes" : "no",
          e.reasons.join("; "),
        ]),
      ),
      "",
    );
  }

  out.push("## Best Data Source", "");
  out.push(`\`${rec.source}\``, "", rec.why, "");
  const bestRest = f.rest[0];
  if (top?.id === "rest-api" && bestRest) out.push("Response shape:", "", "```", bestRest.assessment.schema, "```", "");

  out.push("## Pagination", "");
  out.push(rec.pagination, "");
  if (f.pagination.length) {
    out.push(
      table(
        ["Source", "Endpoint", "Type", "Request", "Response", "Confirmed"],
        f.pagination.map((p) => [
          p.source,
          `\`${p.endpoint}\``,
          paginationLabel(p),
          p.requestParams.join(", ") || "-",
          p.responseFields.join(", ") || "-",
          p.confirmed ? "yes" : "no",
        ]),
      ),
      "",
    );
    for (const p of f.pagination.slice(0, 3)) out.push(`- \`${p.endpoint}\`: ${describePagination(p)}`);
    out.push("");
  }

  out.push("## Authentication", "");
  out.push(
    `- Mechanisms: ${f.auth.mechanisms.join(", ") || "None detected"}`,
    `- Authentication required: ${f.auth.authRequired}`,
    `- Browser needed for login: ${f.auth.browserNeededForLogin}`,
    `- Browser needed after login: ${f.auth.browserNeededAfterLogin}`,
    ...(f.auth.sessionCookies.length ? [`- Session-like cookies (names only): ${f.auth.sessionCookies.map((c) => `\`${c.name}\``).join(", ")}`] : []),
    ...(f.auth.csrfHeaders.length ? [`- CSRF headers: ${f.auth.csrfHeaders.join(", ")}`] : []),
    ...(f.auth.deniedResponses.length ? [`- 401/403 responses: ${f.auth.deniedResponses.map((d) => `${d.status} \`${d.url}\``).join(", ")}`] : []),
    ...(f.auth.botProtection.length ? [`- Bot protection: ${f.auth.botProtection.join(", ")}`] : []),
    ...f.auth.notes.map((n) => `- ${n}`),
    "",
    "_Credential values are never captured or stored._",
    "",
  );

  out.push("## Recommended Extraction Strategy", "");
  out.push(
    `_Generated by: ${rec.generatedBy === "gemini" ? `Gemini (${r.ai.model ?? "unknown model"}) from sanitized findings` : "deterministic rules"}._${r.ai.note ? ` ${r.ai.note}` : ""}`,
    "",
    `**Use:** ${top?.id === rec.strategy ? top.label : rec.strategy}: \`${rec.source}\``,
    "",
    `**Why:** ${rec.why}`,
    "",
    `**Pagination:** ${rec.pagination}`,
    "",
    `**Browser requirement:** ${BROWSER_LABEL[rec.browserRequired]}${rec.browserOnlyForAuth ? " (only to log in)" : ""}`,
    "",
    "**State to preserve:**",
    "",
    list(rec.statePreserve),
    "",
    "**Avoid:**",
    "",
    list(rec.avoid),
    "",
  );

  out.push("## TypeScript Example", "");
  out.push("```ts", r.codeExample, "```", "");

  out.push("## Uncertainties", "");
  out.push(list(r.uncertainties, "_None noted._"), "");

  return redactText(out.join("\n"));
}
