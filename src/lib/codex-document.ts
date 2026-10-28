import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Temporal } from "@js-temporal/polyfill";
import { prepareDocumentImages, prepareDocumentText } from "./document-images";
import { recognizeWithCodex } from "./codex-recognition";
import { type RecognitionResult, recognitionUsageSchema } from "./recognition";
import { instantOf } from "./model";

function complete(result: RecognitionResult): boolean {
  if (!result.events.length || result.warnings.length) return false;
  return result.events.every((event) => {
    if (
      event.needsReview ||
      event.reviewReason ||
      !event.title.trim() ||
      !event.date ||
      !event.time ||
      !event.timeZone ||
      !event.endDate ||
      !event.endTime ||
      !event.endTimeZone
    )
      return false;
    try {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(event.date) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(event.endDate) ||
        !/^\d{2}:\d{2}$/.test(event.time) ||
        !/^\d{2}:\d{2}$/.test(event.endTime)
      )
        return false;
      Temporal.PlainDate.from(event.date);
      Temporal.PlainDate.from(event.endDate);
      return (
        instantOf(`${event.endDate}T${event.endTime}`, event.endTimeZone) >
        instantOf(`${event.date}T${event.time}`, event.timeZone)
      );
    } catch {
      return false;
    }
  });
}

function combinedUsage(
  first: RecognitionResult,
  second: RecognitionResult,
): RecognitionResult["usage"] {
  if (!first.usage || !second.usage) return undefined;
  const a = first.usage,
    b = second.usage;
  const usage = recognitionUsageSchema.safeParse({
    provider: "codex",
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens:
      a.cachedInputTokens !== undefined && b.cachedInputTokens !== undefined
        ? a.cachedInputTokens + b.cachedInputTokens
        : undefined,
    reasoningOutputTokens:
      a.reasoningOutputTokens !== undefined &&
      b.reasoningOutputTokens !== undefined
        ? a.reasoningOutputTokens + b.reasoningOutputTokens
        : undefined,
  });
  return usage.success ? usage.data : undefined;
}

export async function recognizeCodexDocument(
  file: File,
  workspace: string,
  instructions: string,
  signal?: AbortSignal,
): Promise<RecognitionResult> {
  // Bound the whole text + optional image sequence, rather than each attempt only.
  const timeout = AbortSignal.timeout(210_000);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let textResult: RecognitionResult | undefined;
  if (file.type === "application/pdf") {
    const text = await prepareDocumentText(file, workspace, bounded);
    if (text !== null) {
      const textWorkspace = path.join(workspace, "text");
      await mkdir(textWorkspace);
      textResult = await recognizeWithCodex(
        [],
        textWorkspace,
        instructions,
        bounded,
        text,
      );
      if (complete(textResult)) return textResult;
    }
  }
  const imageWorkspace = path.join(workspace, "images");
  await mkdir(imageWorkspace);
  const images = await prepareDocumentImages(file, imageWorkspace, bounded);
  const imageResult = await recognizeWithCodex(
    images,
    imageWorkspace,
    instructions,
    bounded,
  );
  return textResult
    ? { ...imageResult, usage: combinedUsage(textResult, imageResult) }
    : imageResult;
}
