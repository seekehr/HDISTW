import { z } from "zod";

export const RecordSetSchema = z.object({
  /** Dotted path to the array inside the payload, e.g. `data.products` or `edges[].node`. */
  path: z.string(),
  count: z.number().int(),
  keys: z.array(z.string()),
  signals: z.array(z.enum(["id", "title", "price", "image", "url", "date"])),
});
export type RecordSet = z.infer<typeof RecordSetSchema>;

/** Data-quality assessment shared by every JSON-ish source (REST, GraphQL, Next.js, embedded state). */
export const PayloadAssessmentSchema = z.object({
  score: z.number(),
  reasons: z.array(z.string()),
  recordSet: RecordSetSchema.optional(),
  /** Fraction (0..1) of sampled records whose text is visible on the page. */
  visibleOverlap: z.number(),
  paginationFields: z.array(z.string()),
  /** Compact type-only schema, safe to share (no values). */
  schema: z.string(),
});
export type PayloadAssessment = z.infer<typeof PayloadAssessmentSchema>;

export const FrameworkFindingSchema = z.object({
  name: z.string(),
  detected: z.array(z.object({ name: z.string(), signals: z.array(z.string()) })),
});
export type FrameworkFinding = z.infer<typeof FrameworkFindingSchema>;

export const RestCandidateSchema = z.object({
  method: z.string(),
  /** Redacted absolute URL of the best-scoring sample. */
  url: z.string(),
  /** Short form for display, e.g. `GET /api/products?page=1`. */
  display: z.string(),
  endpointKey: z.string(),
  score: z.number(),
  reasons: z.array(z.string()),
  status: z.number().optional(),
  occurrences: z.number().int(),
  sentCookies: z.boolean(),
  sentAuthorization: z.boolean(),
  requestBody: z.string().optional(),
  assessment: PayloadAssessmentSchema,
});
export type RestCandidate = z.infer<typeof RestCandidateSchema>;

export const GraphQLOperationSchema = z.object({
  endpoint: z.string(),
  method: z.string(),
  operationName: z.string().optional(),
  operationType: z.enum(["query", "mutation", "subscription", "unknown"]),
  /** Query text, if sent (absent for persisted queries). */
  query: z.string().optional(),
  persistedQueryHash: z.string().optional(),
  /** Redacted variables. */
  variables: z.record(z.string(), z.unknown()).optional(),
  entityType: z.string().optional(),
  paginationFields: z.array(z.string()),
  status: z.number().optional(),
  occurrences: z.number().int(),
  sentCookies: z.boolean(),
  sentAuthorization: z.boolean(),
  score: z.number(),
  reasons: z.array(z.string()),
  assessment: PayloadAssessmentSchema,
});
export type GraphQLOperation = z.infer<typeof GraphQLOperationSchema>;

export const NextjsFindingSchema = z.object({
  detected: z.boolean(),
  router: z.enum(["pages", "app", "unknown"]).optional(),
  signals: z.array(z.string()),
  buildId: z.string().optional(),
  page: z.string().optional(),
  dataFetching: z.array(z.string()),
  nextData: z
    .object({
      sizeBytes: z.number(),
      pagePropsKeys: z.array(z.string()),
      assessment: PayloadAssessmentSchema,
    })
    .optional(),
  /** `/_next/data/...json` requests actually observed. */
  dataRequests: z.array(
    z.object({ url: z.string(), status: z.number().optional(), assessment: PayloadAssessmentSchema }),
  ),
  /** Conventional `/_next/data` URL derived from the build ID. Not observed, not verified. */
  derivedDataUrl: z.string().optional(),
  rscRequests: z.array(z.object({ url: z.string() })),
  flightDataInHtml: z.boolean(),
});
export type NextjsFinding = z.infer<typeof NextjsFindingSchema>;

export const EmbeddedStateSchema = z.object({
  name: z.string(),
  kind: z.enum(["json-ld", "json-script", "window-assignment", "serialized-js"]),
  /** How to locate it, e.g. `script#__APOLLO_STATE__` or `window.__INITIAL_STATE__`. */
  locator: z.string(),
  sizeBytes: z.number(),
  parseable: z.boolean(),
  jsonLdTypes: z.array(z.string()).optional(),
  canReplaceDom: z.boolean(),
  score: z.number(),
  reasons: z.array(z.string()),
  assessment: PayloadAssessmentSchema.optional(),
});
export type EmbeddedState = z.infer<typeof EmbeddedStateSchema>;

export const RenderingTypeSchema = z.enum([
  "server-rendered",
  "client-rendered",
  "hybrid",
  "API-driven",
  "embedded-state-driven",
]);
export type RenderingType = z.infer<typeof RenderingTypeSchema>;

export const RenderingFindingSchema = z.object({
  type: RenderingTypeSchema,
  /** Fraction of visible rendered text already present in the served HTML. */
  initialHtmlCoverage: z.number(),
  initialWords: z.number().int(),
  renderedWords: z.number().int(),
  traits: z.array(z.string()),
  evidence: z.array(z.string()),
});
export type RenderingFinding = z.infer<typeof RenderingFindingSchema>;

export const AuthFindingSchema = z.object({
  mechanisms: z.array(z.string()),
  sessionCookies: z.array(z.object({ name: z.string(), domain: z.string(), httpOnly: z.boolean() })),
  authorizationSchemes: z.array(z.object({ scheme: z.string(), endpoints: z.array(z.string()) })),
  csrfHeaders: z.array(z.string()),
  apiKeyHeaders: z.array(z.string()),
  deniedResponses: z.array(z.object({ url: z.string(), status: z.number() })),
  loginRedirect: z.string().optional(),
  loginFormDetected: z.boolean(),
  botProtection: z.array(z.string()),
  authRequired: z.enum(["no", "likely", "yes", "unknown"]),
  browserNeededForLogin: z.enum(["yes", "no", "unknown"]),
  browserNeededAfterLogin: z.enum(["yes", "probably not", "no", "unknown"]),
  notes: z.array(z.string()),
});
export type AuthFinding = z.infer<typeof AuthFindingSchema>;

export const PaginationTypeSchema = z.enum(["cursor", "token", "offset", "page", "link", "unknown"]);
export type PaginationType = z.infer<typeof PaginationTypeSchema>;

export const PaginationFindingSchema = z.object({
  endpoint: z.string(),
  source: z.enum(["rest", "graphql", "nextjs", "html"]),
  type: PaginationTypeSchema,
  requestParams: z.array(z.string()),
  responseFields: z.array(z.string()),
  observedValues: z.record(z.string(), z.array(z.string())),
  confirmed: z.boolean(),
  evidence: z.array(z.string()),
});
export type PaginationFinding = z.infer<typeof PaginationFindingSchema>;

export const StrategyIdSchema = z.enum([
  "rest-api",
  "graphql",
  "nextjs-data",
  "embedded-json",
  "ssr-html",
  "playwright-dom",
  "browser-auth-http",
]);
export type StrategyId = z.infer<typeof StrategyIdSchema>;

export const BrowserRequirementSchema = z.enum(["no", "login-only", "yes"]);
export type BrowserRequirement = z.infer<typeof BrowserRequirementSchema>;

export const RankedStrategySchema = z.object({
  id: StrategyIdSchema,
  label: z.string(),
  score: z.number(),
  source: z.string().optional(),
  browserRequired: BrowserRequirementSchema,
  reasons: z.array(z.string()),
});
export type RankedStrategy = z.infer<typeof RankedStrategySchema>;

export const FindingsSchema = z.object({
  framework: FrameworkFindingSchema,
  rest: z.array(RestCandidateSchema),
  graphql: z.array(GraphQLOperationSchema),
  nextjs: NextjsFindingSchema,
  embeddedState: z.array(EmbeddedStateSchema),
  rendering: RenderingFindingSchema,
  auth: AuthFindingSchema,
  pagination: z.array(PaginationFindingSchema),
});
export type Findings = z.infer<typeof FindingsSchema>;
