import { z } from "zod";
import { BrowserRequirementSchema, FindingsSchema, RankedStrategySchema, StrategyIdSchema } from "./findings.js";

export const RecommendationSchema = z.object({
  strategy: StrategyIdSchema,
  /** The data source to use, e.g. `GET https://example.com/api/products`. Always an observed source. */
  source: z.string(),
  why: z.string(),
  browserRequired: BrowserRequirementSchema,
  browserOnlyForAuth: z.boolean(),
  pagination: z.string(),
  statePreserve: z.array(z.string()),
  avoid: z.array(z.string()),
  uncertainties: z.array(z.string()),
  generatedBy: z.enum(["deterministic", "gemini"]),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const ReportSchema = z.object({
  tool: z.literal("HowDoIScrapeThisWebsite"),
  version: z.string(),
  target: z.string(),
  finalUrl: z.string(),
  generatedAt: z.string(),
  interactive: z.boolean(),
  stats: z.object({
    capturedRequests: z.number().int(),
    ignoredRequests: z.number().int(),
    jsonResponses: z.number().int(),
    interactionRequests: z.number().int(),
    documentStatus: z.number().int().optional(),
    durationMs: z.number(),
  }),
  findings: FindingsSchema,
  strategies: z.array(RankedStrategySchema),
  recommendation: RecommendationSchema,
  ai: z.object({
    used: z.boolean(),
    model: z.string().optional(),
    note: z.string().optional(),
  }),
  codeExample: z.string(),
  uncertainties: z.array(z.string()),
  errors: z.array(z.string()),
});
export type Report = z.infer<typeof ReportSchema>;
