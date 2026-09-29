/**
 * Detects bot-check / challenge pages (Cloudflare "Just a moment...", CAPTCHAs).
 * hdistw never tries to get past these; it only needs to know when the page it
 * captured is a challenge rather than the real site, so it doesn't analyze the wrong page.
 */

const CHALLENGE_TEXT =
  /just a moment|attention required|checking (if the site connection is secure|your browser)|verify(ing)? you are (a )?human|are you a robot|enable javascript and cookies to continue|captcha|security check to (verify|access)/i;

export interface PageSignals {
  status?: number;
  title: string;
  text: string;
  headers: Record<string, string>;
}

/** Reasons the page looks like a challenge. Empty when it looks like real content. */
export function challengeSignals(p: PageSignals): string[] {
  const out: string[] = [];
  if (p.headers["cf-mitigated"] === "challenge") out.push("Cloudflare challenge");
  if ("x-datadome" in p.headers) out.push("DataDome");
  const words = p.text.split(/\s+/).filter(Boolean).length;
  // Only trust wording on short pages; long pages may just mention "captcha" somewhere.
  if (words < 150 && CHALLENGE_TEXT.test(`${p.title}\n${p.text.slice(0, 3000)}`)) out.push("challenge / CAPTCHA page shown");
  return out;
}

/** True when the captured page is a challenge instead of the site's content. */
export function isBlockedPage(p: PageSignals): boolean {
  const signals = challengeSignals(p);
  if (!signals.length) return false;
  const words = p.text.split(/\s+/).filter(Boolean).length;
  return (p.status ?? 200) >= 400 || words < 150;
}
