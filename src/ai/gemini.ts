import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { BrowserRequirementSchema, StrategyIdSchema, type RankedStrategy } from "../schemas/findings.js";
import type { Recommendation } from "../schemas/report.js";
import { parseJsonText } from "../utils/json.js";
import { redactText } from "../utils/redact.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompts.js";
import { isObservedReference, type SanitizedSummary } from "./sanitize.js";

export const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";

const GeminiOutputSchema = z.object({
  strategy: StrategyIdSchema,
  source: z.string().min(1),
  why: z.string().min(1),
  browserRequired: BrowserRequirementSchema,
  browserOnlyForAuth: z.boolean(),
  pagination: z.string(),
  statePreserve: z.array(z.string()).default([]),
  avoid: z.array(z.string()).default([]),
  uncertainties: z.array(z.string()).default([]),
});

/** Minimal seam so tests can run without the network. */
export interface GeminiClient {
  model: string;
  generate(system: string, prompt: string): Promise<string>;
}

export function createGeminiClient(apiKey: string, model = DEFAULT_GEMINI_MODEL): GeminiClient {
  const ai = new GoogleGenAI({ apiKey });
  return {
    model,
    async generate(system, prompt) {
      const res = await ai.models.generateContent({
        model,
        contents: prompt,
        config: { systemInstruction: system, responseMimeType: "application/json", temperature: 0.2 },
      });
      return res.text ?? "";
    },
  };
}

export interface GeminiResult {
  recommendation: Recommendation;
  used: boolean;
  note?: string;
}

const MENTION = /\b(?:GET|POST|PUT|PATCH|DELETE)\s+(\S+)|https?:\/\/[^\s"'`)<>]+/g;

/**
 * Asks Gemini for the final strategy and validates it against what was
 * actually observed. Falls back to the deterministic recommendation on any failure.
 */
export async function refineWithGemini(
  client: GeminiClient,
  sanitized: SanitizedSummary,
  strategies: RankedStrategy[],
  fallback: Recommendation,
): Promise<GeminiResult> {
  let raw: string;
  try {
    raw = await client.generate(SYSTEM_PROMPT, redactText(buildUserPrompt(sanitized.summary)));
  } catch (err) {
    return { recommendation: fallback, used: false, note: `Gemini request failed: ${(err as Error).message.split("\n")[0]}` };
  }

  const parsed = parseJsonText(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  const result = parsed ? GeminiOutputSchema.safeParse(parsed.value) : undefined;
  if (!result?.success) return { recommendation: fallback, used: false, note: "Gemini returned an invalid response; using the deterministic recommendation." };
  const out = result.data;

  const ranked = strategies.find((s) => s.id === out.strategy);
  if (!ranked) {
    return { recommendation: fallback, used: false, note: `Gemini chose "${out.strategy}", which was not a ranked option; using the deterministic recommendation.` };
  }

  const uncertainties = [...out.uncertainties];
  let source = out.source;
  if (!isObservedReference(source, sanitized.observedSources, sanitized.observedUrls)) {
    uncertainties.push(`Gemini proposed an unobserved source ("${source}"); replaced with the observed one.`);
    source = ranked.source ?? fallback.source;
  }
  const text = [out.why, out.pagination, ...out.avoid, ...out.statePreserve].join("\n");
  const unobserved = [...text.matchAll(MENTION)]
    .map((m) => m[1] ?? m[0])
    .filter((ref) => (ref.startsWith("/") || /^https?:/.test(ref)) && !isObservedReference(ref, sanitized.observedSources, sanitized.observedUrls));
  if (unobserved.length) uncertainties.push(`Gemini mentioned URLs that were not observed (ignore them): ${[...new Set(unobserved)].join(", ")}`);

  // Keep deterministic uncertainties too; Gemini may omit them.
  for (const u of fallback.uncertainties) if (!uncertainties.includes(u)) uncertainties.push(u);

  return {
    used: true,
    recommendation: {
      strategy: out.strategy,
      source,
      why: out.why,
      browserRequired: out.browserRequired,
      browserOnlyForAuth: out.browserOnlyForAuth,
      pagination: out.pagination,
      statePreserve: out.statePreserve,
      avoid: out.avoid,
      uncertainties,
      generatedBy: "gemini",
    },
  };
}
