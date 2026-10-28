import { describe, expect, it } from "vitest";
import { parsePartialDate, completeReviewDate } from "./review-date";

describe("recognition date completion", () => {
  it("keeps the printed month and day without inventing a year", () => {
    expect(parsePartialDate("--02-05")).toBe("05.02.");
    expect(parsePartialDate("--02-29")).toBe("29.02.");
    expect(parsePartialDate("2027-02-05")).toBeNull();
    expect(parsePartialDate(null)).toBeNull();
    expect(parsePartialDate("--02-30")).toBeNull();
  });
  it("requires a complete explicit year and accepts corrected day/month", () => {
    expect(completeReviewDate("05.02.")).toBeNull();
    expect(completeReviewDate("05.02.20")).toBeNull();
    expect(completeReviewDate("05.02.2027")).toBe("2027-02-05");
    expect(completeReviewDate("06.03.2027")).toBe("2027-03-06");
  });
  it("rejects impossible dates and does not normalize them silently", () => {
    expect(completeReviewDate("29.02.2027")).toBeNull();
    expect(completeReviewDate("29.02.2028")).toBe("2028-02-29");
    expect(completeReviewDate("31.04.2027")).toBeNull();
    expect(completeReviewDate("05.02.0000")).toBeNull();
    expect(completeReviewDate("5.2.2027")).toBeNull();
  });
});
