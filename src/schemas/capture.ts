import { z } from "zod";

/**
 * One recorded network request. Headers and request bodies are redacted at
 * capture time; response bodies are kept in memory only (never written to reports).
 */
export const CapturedRequestSchema = z.object({
  id: z.number().int(),
  url: z.string(),
  method: z.string(),
  resourceType: z.string(),
  requestHeaders: z.record(z.string(), z.string()),
  postData: z.string().optional(),
  status: z.number().int().optional(),
  responseHeaders: z.record(z.string(), z.string()),
  contentType: z.string().optional(),
  bodySize: z.number().int().optional(),
  /** Response text, only kept for JSON-like and document responses. */
  bodyText: z.string().optional(),
  bodyTruncated: z.boolean().optional(),
  failure: z.string().optional(),
  isNavigation: z.boolean(),
  startedAt: z.number(),
});
export type CapturedRequest = z.infer<typeof CapturedRequestSchema>;

/** Cookie metadata. Values are never captured. */
export const CookieInfoSchema = z.object({
  name: z.string(),
  domain: z.string(),
  path: z.string(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.string().optional(),
  session: z.boolean(),
});
export type CookieInfo = z.infer<typeof CookieInfoSchema>;

export const DomInfoSchema = z.object({
  title: z.string(),
  hasPasswordField: z.boolean(),
  /** hrefs of `rel=next` links and links that look like page-numbered pagination. */
  paginationLinks: z.array(z.string()),
  hasLoadMoreButton: z.boolean(),
});
export type DomInfo = z.infer<typeof DomInfoSchema>;

export const CaptureSchema = z.object({
  target: z.string(),
  finalUrl: z.string(),
  startedAt: z.string(),
  durationMs: z.number(),
  /** True when a visible window was opened so the user could log in or pass a bot check. */
  usedLoginWindow: z.boolean(),
  document: z.object({
    status: z.number().int().optional(),
    headers: z.record(z.string(), z.string()),
    redirectChain: z.array(z.string()),
  }),
  /** HTML exactly as served by the server, before any JavaScript ran. */
  initialHtml: z.string(),
  /** DOM serialized after the initial load settled. */
  renderedHtml: z.string(),
  /** Visible text after the initial load settled. */
  renderedText: z.string(),
  dom: DomInfoSchema,
  requests: z.array(CapturedRequestSchema),
  ignored: z.object({
    total: z.number().int(),
    byReason: z.record(z.string(), z.number().int()),
  }),
  cookies: z.array(CookieInfoSchema),
  errors: z.array(z.string()),
});
export type Capture = z.infer<typeof CaptureSchema>;
