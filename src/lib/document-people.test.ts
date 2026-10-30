import { describe, expect, it } from "vitest";
import {
  documentPeople,
  documentPeopleError,
  normalizePersonName,
  personNameOrderKey,
  matchingPersonIds,
} from "./document-people";

describe("explicit people named in document notes", () => {
  it("matches full name order variants while preserving exact spelling normalization", () => {
    const members = [{ id: "same", name: "Anna Ivanova" }];
    expect(matchingPersonIds(" IVANOVA   ANNA ", members)).toEqual(["same"]);
    expect(matchingPersonIds("IVANOVA/ANNA", members)).toEqual(["same"]);
    expect(personNameOrderKey("Иванова Анна Мария")).toBe(
      personNameOrderKey("Анна Мария Иванова"),
    );
    expect(normalizePersonName("IVANOVA ANNA")).toBe("ivanova anna");
  });
  it("does not infer initials, missing words, transliteration or similar surnames", () => {
    const members = [{ id: "same", name: "Anna Ivanova" }];
    for (const name of [
      "Anna",
      "A. Ivanova",
      "Anna Ivanoff",
      "Анна Иванова",
      "Anna Anna Ivanova",
    ])
      expect(matchingPersonIds(name, members)).toEqual([]);
    expect(personNameOrderKey("A. Ivanova")).not.toBe(
      personNameOrderKey("Ivanova A."),
    );
  });
  it("retains all candidate IDs for ambiguous names and confirmed aliases", () => {
    const members = [
      { id: "one", name: "Anna Ivanova" },
      { id: "two", name: "Ivanova Anna" },
      { id: "self", name: "Я" },
    ];
    expect(matchingPersonIds("ANNA IVANOVA", members)).toEqual(["one", "two"]);
    expect(
      matchingPersonIds(
        "IVANOVA ANNA",
        [{ id: "self", name: "Я" }],
        [
          { name: "Anna Ivanova", memberId: "self" },
          { name: "Anna Ivanova", memberId: "deleted" },
        ],
      ),
    ).toEqual(["self"]);
  });
  it("reads only the explicit participant marker and preserves printed names", () => {
    expect(
      documentPeople(
        "J2 077\nУчастники: ANNA IVANOVA; Максим Петров\nБагаж: 20 кг",
      ),
    ).toEqual(["ANNA IVANOVA", "Максим Петров"]);
    expect(
      documentPeople("Гость: Anna Ivanova\nОформил: Максим Петров"),
    ).toEqual([]);
  });
  it("deduplicates exact normalized names without conflating different names", () => {
    expect(
      documentPeople(
        "Участники: Anna   Ivanova; ANNA IVANOVA; Anna; Анна Иванова\nУчастники: Anna",
      ),
    ).toEqual(["Anna Ivanova", "Anna", "Анна Иванова"]);
    expect(normalizePersonName(" ＡＮＮＡ\u00a0 IVANOVA ")).toBe(
      "anna ivanova",
    );
  });
  it("accepts ordinary Unicode names but does not accept IDs or contact details", () => {
    expect(
      documentPeople(
        "Участники: Jean-Luc O’Neill; José García; 李 明; IVANOVA/ANNA; Иванов–Петров",
      ),
    ).toHaveLength(5);
    for (const name of [
      "Anna 123456",
      "test@example.com",
      "https://example.com",
      "A".repeat(61),
    ]) {
      const notes = `Участники: ${name}`;
      expect(documentPeople(notes)).toEqual([]);
      expect(documentPeopleError(notes)).toMatch(/имена/);
    }
  });
  it("does not silently truncate a list beyond the participant limit", () => {
    const names = Array.from(
      { length: 51 },
      (_, index) =>
        `Person ${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`,
    );
    expect(documentPeople(`Участники: ${names.join("; ")}`)).toEqual([]);
    expect(documentPeopleError(`Участники: ${names.join("; ")}`)).toMatch(/50/);
    expect(documentPeople("Нет списка участников")).toEqual([]);
    expect(documentPeopleError("Участники: ")).toBeNull();
  });
});
