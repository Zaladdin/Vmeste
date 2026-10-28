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
