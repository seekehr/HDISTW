import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Capture } from "../schemas/capture.js";
import { ReportSchema, type Report } from "../schemas/report.js";
import { redactText } from "../utils/redact.js";
import { hostnameOf } from "../utils/url.js";
import { renderMarkdown } from "./markdown.js";

export interface WrittenReport {
  dir: string;
  markdownPath: string;
  jsonPath: string;
}

/** Writes report.md, report.json and the captured HTML to `<outDir>/<host>/`. */
export async function writeReport(report: Report, capture: Capture, outDir: string): Promise<WrittenReport> {
  const validated = ReportSchema.parse(report);
  const dir = path.resolve(outDir, hostnameOf(report.finalUrl || report.target).replace(/[^\w.-]/g, "_"));
  await mkdir(dir, { recursive: true });
  const markdownPath = path.join(dir, "report.md");
  const jsonPath = path.join(dir, "report.json");
  await writeFile(markdownPath, renderMarkdown(validated), "utf8");
  await writeFile(jsonPath, redactText(JSON.stringify(validated, null, 2)), "utf8");
  if (capture.initialHtml) await writeFile(path.join(dir, "initial.html"), capture.initialHtml, "utf8");
  if (capture.renderedHtml) await writeFile(path.join(dir, "rendered.html"), capture.renderedHtml, "utf8");
  return { dir, markdownPath, jsonPath };
}
