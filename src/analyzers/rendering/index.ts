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
  const apiInitial = apiSources.filter((s) => s.phase === "initial");
  const apiInteraction = apiSources.filter((s) => s.phase === "interaction");
  const nextDataGood =
    !!nextjs.nextData?.assessment.recordSet && (nextjs.nextData?.assessment.visibleOverlap ?? 0) >= 0.5;
  const embeddedGood = embedded.some((e) => e.canReplaceDom) || nextDataGood;

  const traits: string[] = [];
  const evidence: string[] = [
    `${Math.round(coverage * 100)}% of visible text is present in the served HTML`,
    `served HTML has ~${initialWords} words of text; rendered page has ~${renderedWords}`,
  ];
  if (apiInitial.length) {
    traits.push("page data fetched by JavaScript during load");
    evidence.push(`${apiInitial.length} data request(s) during initial load match visible content`);
  }
  if (embeddedGood) {
    traits.push("page data serialized in the HTML");
    evidence.push("embedded state contains the visible records");
  }
  if (apiInteraction.length) {
    traits.push("more data loaded on interaction");
    evidence.push(`${apiInteraction.length} data request(s) only appeared after interaction`);
  }
  if (nextjs.detected) traits.push(`Next.js (${nextjs.router ?? "unknown"} router)`);
  if (capture.dom.hasLoadMoreButton) traits.push("load-more button present");

  let type: RenderingType;
  if (coverage >= 0.7) {
    type = apiInitial.length ? "hybrid" : "server-rendered";
  } else if (coverage < 0.35) {
    if (embeddedGood) type = "embedded-state-driven";
    else if (apiInitial.length) type = "API-driven";
    else if (apiInteraction.length) type = "interaction-dependent";
    else type = "client-rendered";
  } else {
    type = !apiInitial.length && !embeddedGood && apiInteraction.length ? "interaction-dependent" : "hybrid";
  }

  return { type, initialHtmlCoverage: Math.round(coverage * 100) / 100, initialWords, renderedWords, traits, evidence };
}
