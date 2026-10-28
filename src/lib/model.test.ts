import { describe, it, expect } from "vitest";
import {
  parseTrip,
  daysOfTrip,
  instantOf,
  parseImport,
  exportTrip,
  importTrip,
  validateDocument,
  sampleTrip,
  eventsForDay,
} from "./model";

describe("trip data", () => {
  it("shows overnight arrivals with the same event identity and sorts by arrival instant", () => {
    const flight = {
      ...sampleTrip.events[0],
      kind: "flight" as const,
      date: "2027-05-10",
      time: "23:00",
      timeZone: "Europe/Istanbul",
      endLocal: "2027-05-11T03:00",
      endTimeZone: "Asia/Baku",
    };
    const morning = {
      ...flight,
      id: "morning",
      date: "2027-05-11",
      time: "04:00",
      endLocal: undefined,
      endTimeZone: undefined,
    };
    expect(eventsForDay([morning, flight], "2027-05-11")).toEqual([
      flight,
      morning,
    ]);
    expect(eventsForDay([flight], "2027-05-10")).toEqual([flight]);
    expect(eventsForDay([flight], "2027-05-12")).toEqual([]);
    expect(eventsForDay([{ ...flight, kind: "stay" }], "2027-05-11")).toEqual(
      [],
    );
  });
  it("includes a date-line arrival on the previous local calendar day only once", () => {
    const flight = {
      ...sampleTrip.events[0],
      kind: "flight" as const,
      date: "2027-05-11",
      time: "00:30",
      timeZone: "Asia/Tokyo",
      endLocal: "2027-05-10T18:00",
      endTimeZone: "America/Los_Angeles",
    };
    expect(eventsForDay([flight], "2027-05-10")).toEqual([flight]);
    expect(
      eventsForDay([{ ...flight, endLocal: "2027-05-11T18:00" }], "2027-05-11"),
    ).toHaveLength(1);
  });
  it("orders the same travel day by real instant across different timezones", () => {
    const early = {
      ...sampleTrip.events[0],
      id: "early",
      time: "09:00",
      timeZone: "Asia/Baku",
    };
    const later = {
      ...sampleTrip.events[0],
      id: "later",
      time: "08:30",
      timeZone: "Europe/Istanbul",
    };
    expect(eventsForDay([later, early], early.date).map((e) => e.id)).toEqual([
      "early",
      "later",
    ]);
  });
  it("rejects impossible dates and reversed date ranges", () => {
    expect(() =>
      parseTrip({ ...sampleTrip, startDate: "2027-02-30" }),
    ).toThrow();
    expect(() => parseTrip({ ...sampleTrip, endDate: "2026-01-01" })).toThrow();
  });
  it("enumerates inclusive days independently of computer timezone", () => {
    expect(daysOfTrip("2027-05-10", "2027-05-12")).toEqual([
      "2027-05-10",
      "2027-05-11",
      "2027-05-12",
    ]);
  });
  it("calculates actual instants for a flight with different timezones", () => {
    const start = instantOf("2027-05-10T09:30", "Asia/Baku");
    const end = instantOf("2027-05-10T11:40", "Europe/Istanbul");
    expect((end - start) / 60000).toBe(190);
  });
  it("rejects unknown zones and nonexistent DST times", () => {
    expect(() => instantOf("2027-05-10T09:30", "Fake/Zone")).toThrow();
    expect(() => instantOf("2027-03-28T02:30", "Europe/Berlin")).toThrow();
  });
  it("rejects event times outside trip and arrivals before departures", () => {
    expect(() =>
      parseTrip({
        ...sampleTrip,
        events: [{ ...sampleTrip.events[0], date: "2027-06-10" }],
      }),
    ).toThrow();
    expect(() =>
      parseTrip({
        ...sampleTrip,
        events: [{ ...sampleTrip.events[0], endLocal: "2027-05-10T01:00" }],
      }),
    ).toThrow();
  });
  it("rejects oversize, invalid format and dangling participant IDs", () => {
    expect(() => parseImport("x".repeat(16 * 1024 * 1024 + 1))).toThrow();
    expect(() => parseImport('{"version":99}')).toThrow();
    expect(() =>
      parseTrip({
        ...sampleTrip,
        events: [{ ...sampleTrip.events[0], memberIds: ["missing"] }],
      }),
    ).toThrow();
  });
  it("can reimport a maximum event count plan with long multilingual notes", () => {
    const trip = {
      ...sampleTrip,
      events: Array.from({ length: 1000 }, (_, i) => ({
        ...sampleTrip.events[0],
        id: `event-${i}`,
        details: "Я".repeat(2000),
      })),
    };
    const raw = exportTrip(trip);
    expect(new TextEncoder().encode(raw).length).toBeGreaterThan(1024 * 1024);
    expect(importTrip(raw).events).toHaveLength(1000);
  });
  it("round trips JSON with fresh IDs and preserves participant links", () => {
    const original = parseTrip({
      ...sampleTrip,
      events: [
        { ...sampleTrip.events[0], memberIds: [sampleTrip.members[0].id] },
      ],
    });
    const result = importTrip(exportTrip(original));
    expect(result.title).toBe(original.title);
    expect(result.id).not.toBe(original.id);
    expect(result.events[0].id).not.toBe(original.events[0].id);
    expect(result.events[0].memberIds).toEqual([result.members[0].id]);
  });
  it("limits duration and rejects extra import fields", () => {
    expect(() => parseTrip({ ...sampleTrip, endDate: "2028-12-31" })).toThrow();
    const value = JSON.parse(exportTrip(sampleTrip));
    value.extra = true;
    expect(() => parseImport(JSON.stringify(value))).toThrow();
  });
  it("limits document formats and sizes", () => {
    expect(() => validateDocument({ type: "text/html", size: 100 })).toThrow();
    expect(() =>
      validateDocument({ type: "application/pdf", size: 21 * 1024 * 1024 }),
    ).toThrow();
    expect(() =>
      validateDocument({ type: "application/pdf", size: 200 }),
    ).not.toThrow();
  });
});
