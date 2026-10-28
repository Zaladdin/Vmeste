import { z } from "zod";
import { instantOf, parseTrip, type Trip, type TripEvent } from "./model";

const nullableText = (max: number) => z.string().max(max).nullable();
export const bookingDraftSchema = z
  .object({
    kind: z.enum(["flight", "stay", "transport"]),
    title: z.string().max(160),
    date: nullableText(10),
    time: nullableText(5),
    timeZone: nullableText(80),
    endDate: nullableText(10),
    endTime: nullableText(5),
    endTimeZone: nullableText(80),
    location: z.string().max(300),
    details: z.string().max(2000),
    needsReview: z.boolean(),
    reviewReason: nullableText(500),
  })
  .strict();
export type BookingDraft = z.infer<typeof bookingDraftSchema>;
export const recognitionResultSchema = z
  .object({
    events: z.array(bookingDraftSchema).max(50),
    warnings: z.array(z.string().max(500)).max(20),
  })
  .strict();
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const recognitionUsageSchema = z
  .object({
    provider: z.literal("codex"),
    inputTokens: tokenCount,
    cachedInputTokens: tokenCount.optional(),
    outputTokens: tokenCount,
    reasoningOutputTokens: tokenCount.optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.cachedInputTokens ?? 0) <= value.inputTokens &&
      (value.reasoningOutputTokens ?? 0) <= value.outputTokens &&
      Number.isSafeInteger(value.inputTokens + value.outputTokens),
  );
// Transport metadata comes from the CLI, never from model-generated JSON.
export const recognitionResponseSchema = recognitionResultSchema.extend({
  usage: recognitionUsageSchema.optional(),
});
export type RecognitionResult = z.infer<typeof recognitionResponseSchema>;
export type ImportOptions = { reviewed?: boolean; expandDates?: boolean };
export type ImportPlan = {
  trip: Trip;
  eventIds: string[];
  added: number;
  duplicates: number;
  needsReview: boolean;
  reasons: string[];
};

function identity(event: TripEvent): string {
  const title = event.title
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return `${event.kind}:${instantOf(`${event.date}T${event.time}`, event.timeZone)}:${title}`;
}
/** Unknown dates, times and zones stay unknown. No invented check-in defaults. */
export function buildImportPlan(
  trip: Trip,
  drafts: BookingDraft[],
  options: ImportOptions = {},
): ImportPlan {
  const empty = (reasons: string[]): ImportPlan => ({
    trip,
    eventIds: [],
    added: 0,
    duplicates: 0,
    needsReview: true,
    reasons: [...new Set(reasons)],
  });
  if (!drafts.length)
    return {
      ...empty(["В документе не найдено билетов или бронирований"]),
      needsReview: false,
    };
  const reasons: string[] = [];
  const candidates: TripEvent[] = [];
  let startDate = trip.startDate,
    endDate = trip.endDate;
  for (const raw of drafts) {
    const result = bookingDraftSchema.safeParse(raw);
    if (!result.success) {
      reasons.push("Некорректный результат распознавания");
      continue;
    }
    const draft = result.data;
    if (draft.needsReview && !options.reviewed)
      reasons.push(draft.reviewReason || `Проверьте событие «${draft.title}»`);
    if (!draft.date || !draft.time || !draft.timeZone) {
      reasons.push(`Уточните дату, время и часовой пояс: ${draft.title}`);
      continue;
    }
    const hasEnd =
      draft.endDate !== null ||
      draft.endTime !== null ||
      draft.endTimeZone !== null;
    if (hasEnd && (!draft.endDate || !draft.endTime || !draft.endTimeZone)) {
      reasons.push(
        `Уточните дату, время и часовой пояс окончания: ${draft.title}`,
      );
      continue;
    }
    if ((draft.kind === "stay" || draft.kind === "flight") && !hasEnd) {
      reasons.push(`Уточните окончание: ${draft.title}`);
      continue;
    }
    const event: TripEvent = {
      id: crypto.randomUUID(),
      kind: draft.kind,
      title: draft.title,
      date: draft.date,
      time: draft.time,
      timeZone: draft.timeZone,
      location: draft.location,
      details: draft.details,
      memberIds: [],
      ...(hasEnd
        ? {
            endLocal: `${draft.endDate}T${draft.endTime}`,
            endTimeZone: draft.endTimeZone!,
          }
        : {}),
    };
    const finish = draft.endDate ?? event.date;
    if (
      event.date < trip.startDate ||
      event.date > trip.endDate ||
      finish > trip.endDate ||
      finish < trip.startDate
    ) {
      if (!options.expandDates)
        reasons.push(
          "Даты бронирования выходят за пределы поездки. Проверьте поездку и разрешите расширить её даты.",
        );
      startDate = [startDate, event.date, finish].sort()[0];
      endDate = [endDate, event.date, finish].sort().at(-1)!;
    }
    candidates.push(event);
  }
  if (reasons.length) return empty(reasons);
  try {
    parseTrip({ ...trip, startDate, endDate, events: candidates });
    // Dedupe against canonical persisted events, without overwriting user edits.
    const known = new Map(
      trip.events.map((event) => [identity(event), event.id]),
    );
    const events = [...trip.events];
    const eventIds = new Set<string>();
    let added = 0,
      duplicates = 0;
    for (const candidate of candidates) {
      const key = identity(candidate);
      const match = known.get(key);
      if (match) {
        eventIds.add(match);
        duplicates++;
      } else {
        known.set(key, candidate.id);
        events.push(candidate);
        eventIds.add(candidate.id);
        added++;
      }
    }
    return {
      trip: parseTrip({ ...trip, startDate, endDate, events }),
      eventIds: [...eventIds],
      added,
      duplicates,
      needsReview: false,
      reasons: [],
    };
  } catch (error) {
    return empty([
      error instanceof Error
        ? error.message
        : "Проверьте распознанные даты и время",
    ]);
  }
}
