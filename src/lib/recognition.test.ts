import { describe, expect, it } from "vitest";
import {
  buildImportPlan,
  recognitionResultSchema,
  type BookingDraft,
} from "./recognition";
import { sampleTrip } from "./model";

export const flight: BookingDraft = {
  kind: "flight",
  title: "Баку → Стамбул",
  date: "2027-05-10",
  time: "09:30",
  timeZone: "Asia/Baku",
  endDate: "2027-05-10",
  endTime: "11:40",
  endTimeZone: "Europe/Istanbul",
  location: "Istanbul Airport",
  details: "J2 077",
  needsReview: false,
  reviewReason: null,
};
describe("recognition import plan", () => {
  it("adds named document travelers to the trip and the corresponding events", () => {
    const trip = { ...sampleTrip, members: [], events: [] };
    const result = buildImportPlan(trip, [
      { ...flight, details: "J2 077\nУчастники: Anna Ivanova; Максим Петров" },
      {
        ...flight,
        title: "Дальнейший перелёт",
        details: "Участники: ANNA IVANOVA",
      },
    ]);
    expect(result.needsReview).toBe(false);
    expect(result.trip.members.map((member) => member.name)).toEqual([
      "Anna Ivanova",
      "Максим Петров",
    ]);
    expect(result.trip.events[0].memberIds).toEqual(
      result.trip.members.map((member) => member.id),
    );
    expect(result.trip.events[1].memberIds).toEqual([
      result.trip.members[0].id,
    ]);
    expect(trip.members).toEqual([]);
  });
  it("unions new traveler links into a duplicate event without overwriting edits or IDs", () => {
    const trip = {
      ...sampleTrip,
      members: [{ id: "anna", name: "Anna Ivanova" }],
      events: [],
    };
    const seed = buildImportPlan(trip, [
      { ...flight, details: "Участники: ANNA IVANOVA" },
    ]).trip;
    const event = {
      ...seed.events[0],
      location: "Edited address",
      details: "User note",
    };
    const current = { ...seed, events: [event] };
    const result = buildImportPlan(current, [
      { ...flight, details: "Участники: Anna Ivanova; Максим Петров" },
    ]);
    expect(result.added).toBe(0);
    expect(result.trip.members).toHaveLength(2);
    expect(result.trip.events[0]).toEqual({
      ...event,
      memberIds: result.trip.members.map((member) => member.id),
    });
    const again = buildImportPlan(result.trip, [
      { ...flight, details: "Участники: ANNA IVANOVA; МАКСИМ ПЕТРОВ" },
    ]);
    expect(again.trip.members).toEqual(result.trip.members);
    expect(again.trip.events[0]).toEqual(result.trip.events[0]);
    expect(current.events[0].memberIds).toEqual(["anna"]);
  });
  it("does not add people or links until all recognized events can be imported", () => {
    const trip = { ...sampleTrip, members: [], events: [] };
    for (const draft of [
      { ...flight, date: "--05-10" },
      { ...flight, needsReview: true, reviewReason: "Уточните время" },
      { ...flight, date: "2027-02-30" },
    ]) {
      const result = buildImportPlan(trip, [
        { ...draft, details: "Участники: Anna Ivanova" },
      ]);
      expect(result.needsReview).toBe(true);
      expect(result.trip).toBe(trip);
      expect(result.trip.members).toEqual([]);
    }
  });
  it("keeps all named passengers when repeated legs collapse into one event", () => {
    const trip = { ...sampleTrip, members: [], events: [] };
    const result = buildImportPlan(trip, [
      { ...flight, details: "Участники: Anna Ivanova" },
      { ...flight, details: "Участники: Максим Петров" },
    ]);
    expect(result.added).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.trip.events[0].memberIds).toEqual(
      result.trip.members.map((member) => member.id),
    );
    const fullTrip = {
      ...result.trip,
      members: [
        ...result.trip.members,
        ...Array.from({ length: 48 }, (_, index) => ({
          id: `other-${index}`,
          name: `Other ${index}`,
        })),
      ],
    };
    expect(
      buildImportPlan(fullTrip, [
        { ...flight, details: "Участники: ANNA IVANOVA" },
      ]).needsReview,
    ).toBe(false);
  });
  it("requests review rather than silently truncating invalid or excess people", () => {
    const fullTrip = {
      ...sampleTrip,
      events: [],
      members: Array.from({ length: 50 }, (_, index) => ({
        id: `person-${index}`,
        name: `Existing ${index}`,
      })),
    };
    const excess = buildImportPlan(fullTrip, [
      { ...flight, details: "Участники: New Traveler" },
    ]);
    expect(excess.needsReview).toBe(true);
    expect(excess.trip).toBe(fullTrip);
    const invalid = buildImportPlan(sampleTrip, [
      { ...flight, details: `Участники: ${"A".repeat(61)}` },
    ]);
    expect(invalid.needsReview).toBe(true);
    expect(invalid.reasons.join(" ")).toMatch(/имена/);
  });
  it("preserves a known day/month but requires a confirmed year before import", () => {
    const draft = {
      ...flight,
      date: "--05-10",
      endDate: "--05-10",
      needsReview: true,
    };
    const parsed = recognitionResultSchema.parse({
      events: [draft],
      warnings: [],
    });
    expect(parsed.events[0].date).toBe("--05-10");
    const trip = { ...sampleTrip, events: [] };
    expect(
      buildImportPlan(trip, parsed.events, { reviewed: true }).needsReview,
    ).toBe(true);
    expect(buildImportPlan(trip, parsed.events, { reviewed: true }).added).toBe(
      0,
    );
    expect(
      buildImportPlan(trip, parsed.events, { reviewed: true }).reasons.join(
        " ",
      ),
    ).toMatch(/год/);
    expect(
      buildImportPlan(
        trip,
        [{ ...draft, date: "2027-05-10", endDate: "2027-05-10" }],
        { reviewed: true },
      ).added,
    ).toBe(1);
  });
  it("creates every leg and a stay with their real timezones", () => {
    const trip = { ...sampleTrip, events: [] };
    const hotel: BookingDraft = {
      ...flight,
      kind: "stay",
      title: "Karaköy Rooms",
      date: "2027-05-10",
      time: "15:00",
      timeZone: "Europe/Istanbul",
      endDate: "2027-05-15",
      endTime: "12:00",
      endTimeZone: "Europe/Istanbul",
      location: "Kemankeş Cd. 10",
      details: "Бронирование отеля",
    };
    const result = buildImportPlan(trip, [flight, hotel]);
    expect(result.trip.events).toHaveLength(2);
    expect(result.eventIds).toHaveLength(2);
    expect(result.trip.events[0].endTimeZone).toBe("Europe/Istanbul");
    expect(result.trip.events[1].endLocal).toBe("2027-05-15T12:00");
  });
  it("never guesses missing check-in times or timezones", () => {
    const result = buildImportPlan({ ...sampleTrip, events: [] }, [
      {
        ...flight,
        time: null,
        needsReview: true,
        reviewReason: "Не указано время",
      },
    ]);
    expect(result.needsReview).toBe(true);
    expect(result.trip.events).toEqual([]);
  });
  it("requires review for out-of-range bookings and expands only with explicit option", () => {
    const later = { ...flight, date: "2027-05-16", endDate: "2027-05-16" };
    expect(buildImportPlan(sampleTrip, [later]).needsReview).toBe(true);
    const result = buildImportPlan(sampleTrip, [later], {
      reviewed: true,
      expandDates: true,
    });
    expect(result.trip.endDate).toBe("2027-05-16");
    expect(result.added).toBe(1);
  });
  it("does not duplicate the same flight across files or repeated legs", () => {
    const result = buildImportPlan({ ...sampleTrip, events: [] }, [
      flight,
      { ...flight, title: "  БАКУ  → СТАМБУЛ " },
    ]);
    expect(result.added).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.eventIds).toHaveLength(1);
    const repeated = buildImportPlan(result.trip, [flight]);
    expect(repeated.added).toBe(0);
    expect(repeated.eventIds).toEqual(result.eventIds);
  });
  it("keeps separate flights with same time but different destinations", () => {
    const result = buildImportPlan({ ...sampleTrip, events: [] }, [
      flight,
      { ...flight, title: "Баку → Лондон" },
    ]);
    expect(result.added).toBe(2);
  });
  it("rejects invalid dates and reversed instants without partial changes", () => {
    const invalid = buildImportPlan({ ...sampleTrip, events: [] }, [
      flight,
      { ...flight, title: "Некорректный", date: "2027-02-30" },
    ]);
    expect(invalid.needsReview).toBe(true);
    expect(invalid.trip.events).toEqual([]);
    expect(
      buildImportPlan({ ...sampleTrip, events: [] }, [
        { ...flight, endTime: "01:00" },
      ]).needsReview,
    ).toBe(true);
  });
  it("supports transport and explicit confirmation of uncertain but complete fields", () => {
    const draft = {
      ...flight,
      kind: "transport" as const,
      title: "Поезд",
      needsReview: true,
      reviewReason: "Проверьте время",
    };
    expect(buildImportPlan(sampleTrip, [draft]).needsReview).toBe(true);
    expect(buildImportPlan(sampleTrip, [draft], { reviewed: true }).added).toBe(
      1,
    );
  });
  it("validates and bounds AI output including unknown document types", () => {
    expect(
      recognitionResultSchema.safeParse({
        events: [{ ...flight, kind: "code" }],
        warnings: [],
      }).success,
    ).toBe(false);
    expect(
      recognitionResultSchema.safeParse({
        events: [],
        warnings: ["Не найдено бронирование"],
      }).success,
    ).toBe(true);
  });
  it("does not silently drop partially missing arrival fields", () => {
    expect(
      buildImportPlan(sampleTrip, [{ ...flight, endTime: null }]).needsReview,
    ).toBe(true);
  });
  it("allows duplicate recognition when a trip is already at its event limit", () => {
    const seed = buildImportPlan({ ...sampleTrip, events: [] }, [flight]).trip
      .events[0];
    const trip = {
      ...sampleTrip,
      events: Array.from({ length: 1000 }, (_, i) => ({
        ...seed,
        id: `stored-${i}`,
        title: i ? `Другой рейс ${i}` : seed.title,
      })),
    };
    const result = buildImportPlan(trip, [flight]);
    expect(result.needsReview).toBe(false);
    expect(result.added).toBe(0);
    expect(result.duplicates).toBe(1);
  });
});
