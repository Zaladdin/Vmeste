import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import type { RecognitionResult } from "./recognition";

export const eventKinds = {
  flight: "Перелёт",
  stay: "Проживание",
  transport: "Переезд",
  activity: "Место и прогулка",
} as const;
const id = z.string().min(1).max(100);
const shortText = z.string().trim().min(1).max(160);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    try {
      return Temporal.PlainDate.from(value).toString() === value;
    } catch {
      return false;
    }
  }, "Некорректная дата");
const zone = z
  .string()
  .max(80)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("ru", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Укажите часовой пояс, например Europe/Istanbul");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
export const eventSchema = z
  .object({
    id,
    kind: z.enum(["flight", "stay", "transport", "activity"]),
    title: shortText,
    date,
    time,
    timeZone: zone,
    endLocal: localDateTime.optional(),
    endTimeZone: zone.optional(),
    location: z.string().trim().max(300),
    details: z.string().trim().max(2000),
    memberIds: z.array(id).max(50),
  })
  .strict();
export type TripEvent = z.infer<typeof eventSchema>;
const tripSchema = z
  .object({
    id,
    title: shortText,
    destination: shortText,
    startDate: date,
    endDate: date,
    timeZone: zone,
    members: z
      .array(z.object({ id, name: z.string().trim().min(1).max(60) }).strict())
      .max(50),
    events: z.array(eventSchema).max(1000),
  })
  .strict()
  .superRefine((trip, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (trip.endDate < trip.startDate)
      fail("Окончание поездки должно быть после начала");
    try {
      if (
        Temporal.PlainDate.from(trip.startDate).until(trip.endDate).days > 365
      )
        fail("Максимальная длительность поездки — 366 дней");
    } catch {
      fail("Проверьте даты поездки");
    }
    if (new Set(trip.members.map((m) => m.id)).size !== trip.members.length)
      fail("Повторяющиеся участники");
    if (new Set(trip.events.map((e) => e.id)).size !== trip.events.length)
      fail("Повторяющиеся события");
    for (const event of trip.events) {
      if (event.date < trip.startDate || event.date > trip.endDate)
        fail("Дата события должна быть в пределах поездки");
      if (
        event.memberIds.some(
          (id) => !trip.members.some((member) => member.id === id),
        )
      )
        fail("Участник события не найден");
      try {
        const start = instantOf(`${event.date}T${event.time}`, event.timeZone);
        if (event.endLocal && !event.endTimeZone)
          fail("Укажите часовой пояс окончания");
        if (
          event.endLocal &&
          event.endTimeZone &&
          instantOf(event.endLocal, event.endTimeZone) < start
        )
          fail("Окончание события раньше начала с учётом часовых поясов");
      } catch {
        fail(
          "Не удалось определить время события. Проверьте дату и часовой пояс",
        );
      }
    }
  });
export type Trip = z.infer<typeof tripSchema>;
export type StoredDocument = {
  id: string;
  tripId: string;
  eventId?: string;
  name: string;
  type: string;
  size: number;
  blob: Blob;
  fingerprint?: string;
  eventIds?: string[];
  /** Names explicitly confirmed from this document, including mapped aliases. */
  people?: { name: string; memberId: string }[];
  recognition?: {
    status:
      | "queued"
      | "processing"
      | "completed"
      | "needs_review"
      | "failed"
      | "empty";
    message: string;
    result?: RecognitionResult;
    attemptId?: string;
    startedAt?: number;
    cloudJobId?: string;
    cloudUserId?: string;
  };
};
export function linkedEventIds(document: StoredDocument): string[] {
  return [
    ...new Set([
      ...(document.eventIds ?? []),
      ...(document.eventId ? [document.eventId] : []),
    ]),
  ];
}
export function parseTrip(value: unknown): Trip {
  const result = tripSchema.safeParse(value);
  if (!result.success)
    throw new Error(result.error.issues[0]?.message ?? "Некорректная поездка");
  return result.data;
}
export function instantOf(local: string, timeZone: string): number {
  return Temporal.PlainDateTime.from(local).toZonedDateTime(timeZone, {
    disambiguation: "reject",
  }).epochMilliseconds;
}
export function eventsForDay(events: TripEvent[], day: string): TripEvent[] {
  return events
    .filter((event) => event.date === day || isArrivalOnDay(event, day))
    .sort((a, b) => eventDayInstant(a, day) - eventDayInstant(b, day));
}
export function isArrivalOnDay(event: TripEvent, day: string): boolean {
  return (
    (event.kind === "flight" || event.kind === "transport") &&
    event.date !== day &&
    event.endLocal?.slice(0, 10) === day &&
    !!event.endTimeZone
  );
}
function eventDayInstant(event: TripEvent, day: string): number {
  return isArrivalOnDay(event, day)
    ? instantOf(event.endLocal!, event.endTimeZone!)
    : instantOf(`${event.date}T${event.time}`, event.timeZone);
}
export function daysOfTrip(start: string, end: string): string[] {
  const first = Temporal.PlainDate.from(start);
  const last = Temporal.PlainDate.from(end);
  if (
    Temporal.PlainDate.compare(first, last) > 0 ||
    first.until(last).days > 365
  )
    throw new Error("Проверьте период поездки");
  const days: string[] = [];
  for (
    let day = first;
    Temporal.PlainDate.compare(day, last) <= 0;
    day = day.add({ days: 1 })
  )
    days.push(day.toString());
  return days;
}
export function formatDate(
  value: string,
  options: Intl.DateTimeFormatOptions = { day: "numeric", month: "long" },
): string {
  return new Intl.DateTimeFormat("ru-RU", {
    ...options,
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}
export function mapLink(place: string): string {
  const url = new URL("https://www.google.com/maps/search/");
  url.searchParams.set("api", "1");
  url.searchParams.set("query", place);
  return url.toString();
}
const transferSchema = z
  .object({
    format: z.literal("vmeste-trip"),
    version: z.literal(1),
    trip: tripSchema,
  })
  .strict();
export const MAX_PLAN_BYTES = 16 * 1024 * 1024;
export function parseImport(raw: string): Trip {
  if (new TextEncoder().encode(raw).byteLength > MAX_PLAN_BYTES)
    throw new Error("Файл плана должен быть не больше 16 МБ");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Не удалось прочитать JSON-файл");
  }
  const result = transferSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      "Неверный формат плана или данные. Нужен экспорт из приложения Вместе",
    );
  return result.data.trip;
}
export function exportTrip(trip: Trip): string {
  return JSON.stringify(
    { format: "vmeste-trip", version: 1, trip: parseTrip(trip) },
    null,
    2,
  );
}
export function importTrip(raw: string): Trip {
  const trip = parseImport(raw);
  const memberIds = new Map(
    trip.members.map((member) => [member.id, crypto.randomUUID()]),
  );
  return {
    ...trip,
    id: crypto.randomUUID(),
    members: trip.members.map((m) => ({ ...m, id: memberIds.get(m.id)! })),
    events: trip.events.map((e) => ({
      ...e,
      id: crypto.randomUUID(),
      memberIds: e.memberIds.map((id) => memberIds.get(id)!),
    })),
  };
}
export function validateDocument(file: { type: string; size: number }): void {
  if (
    !["application/pdf", "image/png", "image/jpeg", "image/webp"].includes(
      file.type,
    )
  )
    throw new Error("Поддерживаются PDF, JPG, PNG и WebP");
  if (file.size <= 0 || file.size > 20 * 1024 * 1024)
    throw new Error("Документ должен быть непустым и не больше 20 МБ");
}
export const sampleTrip: Trip = {
  id: "istanbul-example",
  title: "Несколько дней в Стамбуле",
  destination: "Стамбул",
  startDate: "2027-05-10",
  endDate: "2027-05-15",
  timeZone: "Europe/Istanbul",
  members: [
    { id: "me", name: "Вы" },
    { id: "anna", name: "Анна" },
  ],
  events: [
    {
      id: "flight-out",
      kind: "flight",
      title: "Баку → Стамбул",
      date: "2027-05-10",
      time: "09:30",
      timeZone: "Asia/Baku",
      endLocal: "2027-05-10T11:40",
      endTimeZone: "Europe/Istanbul",
      location: "Istanbul Airport, Istanbul",
      details: "Азербайджанские авиалинии · J2 077\nGYD → IST",
      memberIds: ["me", "anna"],
    },
    {
      id: "hotel",
      kind: "stay",
      title: "Заселение в отель",
      date: "2027-05-10",
      time: "15:00",
      timeZone: "Europe/Istanbul",
      endLocal: "2027-05-15T12:00",
      endTimeZone: "Europe/Istanbul",
      location: "Kemankeş Cd. 10, Karaköy, Istanbul",
      details: "Karaköy Rooms · до 15 мая",
      memberIds: ["me", "anna"],
    },
    {
      id: "walk",
      kind: "activity",
      title: "Прогулка по Каракёю",
      date: "2027-05-10",
      time: "18:00",
      timeZone: "Europe/Istanbul",
      location: "Karaköy, Istanbul",
      details:
        "Пройдёмся по набережной, заглянем в галереи, кофейни и поднимемся на смотровые площадки района.",
      memberIds: [],
    },
    {
      id: "galata",
      kind: "activity",
      title: "Галатская башня и окрестности",
      date: "2027-05-11",
      time: "10:00",
      timeZone: "Europe/Istanbul",
      location: "Galata Tower, Istanbul",
      details:
        "Утро начнём с вида на Босфор. После — завтрак и прогулка по маленьким улочкам.",
      memberIds: [],
    },
    {
      id: "ferry",
      kind: "transport",
      title: "На пароме в Кадыкёй",
      date: "2027-05-12",
      time: "11:00",
      timeZone: "Europe/Istanbul",
      location: "Karaköy ferry terminal, Istanbul",
      details:
        "Время отправления уточним на причале. Оставим день для азиатской части города.",
      memberIds: [],
    },
    {
      id: "flight-home",
      kind: "flight",
      title: "Стамбул → Баку",
      date: "2027-05-15",
      time: "14:00",
      timeZone: "Europe/Istanbul",
      endLocal: "2027-05-15T17:50",
      endTimeZone: "Asia/Baku",
      location: "Istanbul Airport, Istanbul",
      details: "Обратный перелёт · пример события",
      memberIds: ["me", "anna"],
    },
  ],
};
