import type {
  EmbeddedState,
  GraphQLOperation,
  NextjsFinding,
  RenderingFinding,
  RenderingType,
  RestCandidate,
} from "../../schemas/findings.js";
import { textCoverage, wordCount } from "../../utils/text.js";
import type { AnalysisContext } from "../context.js";

const STRONG_SOURCE = 50;
const VISIBLE = 0.4;

export function analyzeRendering(
  ctx: AnalysisContext,
  rest: RestCandidate[],
  graphql: GraphQLOperation[],
  nextjs: NextjsFinding,
  embedded: EmbeddedState[],
): RenderingFinding {
  const { capture } = ctx;
  const coverage = textCoverage(capture.renderedText, ctx.initialText);
  const initialWords = wordCount(ctx.initialText);
  const renderedWords = wordCount(capture.renderedText);

  const apiSources = [...rest, ...graphql].filter(
    (s) => s.score >= STRONG_SOURCE && s.assessment.visibleOverlap >= VISIBLE,
  );
  const nextDataGood =
    !!nextjs.nextData?.assessment.recordSet && (nextjs.nextData?.assessment.visibleOverlap ?? 0) >= 0.5;
  const embeddedGood = embedded.some((e) => e.canReplaceDom) || nextDataGood;

  const traits: string[] = [];
  const evidence: string[] = [
    `${Math.round(coverage * 100)}% of visible text is present in the served HTML`,
    `served HTML has ~${initialWords} words of text; rendered page has ~${renderedWords}`,
  ];
  if (apiSources.length) {
    traits.push("page data fetched by JavaScript during load");
    evidence.push(`${apiSources.length} data request(s) during initial load match visible content`);
  }
  if (embeddedGood) {
    traits.push("page data serialized in the HTML");
    evidence.push("embedded state contains the visible records");
  }
  if (nextjs.detected) traits.push(`Next.js (${nextjs.router ?? "unknown"} router)`);
  if (capture.dom.hasLoadMoreButton) traits.push("load-more button present");

  let type: RenderingType;
  if (coverage >= 0.7) {
    type = apiSources.length ? "hybrid" : "server-rendered";
  } else if (coverage < 0.35) {
    if (embeddedGood) type = "embedded-state-driven";
    else if (apiSources.length) type = "API-driven";
    else type = "client-rendered";
  } else {
    type = "hybrid";
  }

  return { type, initialHtmlCoverage: Math.round(coverage * 100) / 100, initialWords, renderedWords, traits, evidence };
}
