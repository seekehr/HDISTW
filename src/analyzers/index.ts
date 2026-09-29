import type { Capture } from "../schemas/capture.js";
import type { Findings } from "../schemas/findings.js";
import { analyzeAuth } from "./auth/index.js";
import { buildContext } from "./context.js";
import { analyzeEmbeddedState } from "./embedded-state/index.js";
import { detectFramework } from "./framework.js";
import { analyzeGraphQL } from "./graphql/index.js";
import { analyzeNextjs } from "./nextjs/index.js";
import { analyzePagination } from "./pagination/index.js";
import { analyzeRendering } from "./rendering/index.js";
import { analyzeRest } from "./rest/index.js";

/** Runs every analyzer over a capture. Pure: no network, no browser. */
export function analyzeCapture(capture: Capture): Findings {
  const ctx = buildContext(capture);
  const rest = analyzeRest(ctx);
  const graphql = analyzeGraphQL(ctx);
  const nextjs = analyzeNextjs(ctx);
  const embeddedState = analyzeEmbeddedState(ctx);
  return {
    framework: detectFramework(capture),
    rest,
    graphql,
    nextjs,
    embeddedState,
    rendering: analyzeRendering(ctx, rest, graphql, nextjs, embeddedState),
    auth: analyzeAuth(ctx, rest, graphql, embeddedState),
    pagination: analyzePagination(ctx, rest, graphql, nextjs),
  };
}
