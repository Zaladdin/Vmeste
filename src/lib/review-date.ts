import { Temporal } from "@js-temporal/polyfill";

/** Partial dates retain printed facts; they never acquire a year implicitly. */
export function parsePartialDate(value: string | null): string | null {
  const match = /^--(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  try {
    // A leap reference year validates month/day only; no year is added to the draft.
    Temporal.PlainDate.from(`2000-${match[1]}-${match[2]}`);
    return `${match[2]}.${match[1]}.`;
  } catch {
    return null;
  }
}

export function completeReviewDate(text: string): string | null {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (!match || match[3] === "0000") return null;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  try {
    Temporal.PlainDate.from(iso);
    return iso;
  } catch {
    return null;
  }
}
