import type { Capture, CapturedRequest } from "../schemas/capture.js";
import { htmlToText, VisibleText } from "../utils/text.js";

export interface AnalysisContext {
  capture: Capture;
  pageUrl: string;
  /** Everything the user could see: initial render plus interactive browsing. */
  visible: VisibleText;
  /** Text of the HTML as served, before JavaScript. */
  initialText: string;
}

export function buildContext(capture: Capture): AnalysisContext {
  return {
    capture,
    pageUrl: capture.finalUrl || capture.target,
    visible: new VisibleText(capture.renderedText, capture.interactionText),
    initialText: htmlToText(capture.initialHtml),
  };
}

export const sentCookies = (req: CapturedRequest) => "cookie" in req.requestHeaders;
export const sentAuthorization = (req: CapturedRequest) => "authorization" in req.requestHeaders;

export function isNextDataRequest(req: CapturedRequest): boolean {
  return /\/_next\/data\//.test(req.url);
}

export function isRscRequest(req: CapturedRequest): boolean {
  return (
    !req.isNavigation &&
    (/[?&]_rsc=/.test(req.url) || req.requestHeaders["rsc"] === "1" || /text\/x-component/i.test(req.contentType ?? ""))
  );
}

export function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}
