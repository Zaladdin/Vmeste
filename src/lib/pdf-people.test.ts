import { describe, expect, it } from "vitest";
import { extractPeopleFromPdfText } from "./pdf-people";

it("does not add a preceding Reference column heading to a split name", () => {
  expect(
    extractPeopleFromPdfText(
      "Reference\nANNA (First\nname) IVANOVA (Last name)\nEconomy 12345",
    ),
  ).toEqual(["ANNA IVANOVA"]);
});

describe("passenger and guest candidates from PDF text", () => {
  it("reads every explicitly labelled passenger across pages without document numbers", () => {
    const text = ["IVANOVA ANNA", "IVANOV IVAN", "PETROVA ELENA", "PETROV PETR"]
      .map(
        (name) =>
          `PASSENGER / DOCUMENT NO.\n${name} / C123456789\nBeijing — Phuket`,
      )
      .join("\n--- Page ---\n");
    expect(extractPeopleFromPdfText(text)).toEqual([
      "IVANOVA ANNA",
      "IVANOV IVAN",
      "PETROVA ELENA",
      "PETROV PETR",
    ]);
  });
  it("supports Russian document labels", () => {
    expect(
      extractPeopleFromPdfText(
        "ПАССАЖИР / ДОКУМЕНТ\nИВАНОВ ИВАН / C1234567\nПекин — Фукуок",
      ),
    ).toEqual(["ИВАНОВ ИВАН"]);
  });
  it("skips table headers and removes honorifics and numeric columns", () => {
    expect(
      extractPeopleFromPdfText(
        "Пассажиры / Passengers\nДокумент Номер билета\nMrs Anna Ivanova 123456789 5555555555\nMr Ivan Ivanov 222222 333333\nНомер заказа / Order",
      ),
    ).toEqual(["Anna Ivanova", "Ivan Ivanov"]);
  });
  it("reads labelled hotel guest names but not the guest count", () => {
    expect(
      extractPeopleFromPdfText(
        "Имя   гостя :   Anna Ivanova\nЧисло гостей: 2 взрослых\nBooking agent: Roman Petrov",
      ),
    ).toEqual(["Anna Ivanova"]);
  });
  it("reads multi-row Russian and English receipt sections", () => {
    expect(
      extractPeopleFromPdfText(
        "Пассажир и номер эл. билета\nIVANOVA ANNA 1234567890\nIVANOV IVAN 9876543210\nАвиабилеты\nPassenger & E-ticket No.\nANNA IVANOVA 123456\nFlights",
      ),
    ).toEqual(["IVANOVA ANNA", "IVANOV IVAN", "ANNA IVANOVA"]);
  });
  it("supports separately labelled first and last name fields across line breaks", () => {
    expect(
      extractPeopleFromPdfText(
        "IVANOVA (Фамилия) ANNA (Имя и\nотчество)\nANNA (First\nname) IVANOVA (Last name)",
      ),
    ).toEqual(["IVANOVA ANNA", "ANNA IVANOVA"]);
  });
  it("reads an explicit passenger name field on its next line", () => {
    expect(
      extractPeopleFromPdfText(
        "Passenger name:\nAnna Ivanova\nPassport number: 123456",
      ),
    ).toEqual(["Anna Ivanova"]);
  });
  it("normalizes repeated spelling only while preserving printed ordering", () => {
    expect(
      extractPeopleFromPdfText(
        "Guest name: Anna   Ivanova\nGuest name: ANNA IVANOVA\nGuest name: IVANOVA ANNA",
      ),
    ).toEqual(["Anna Ivanova", "IVANOVA ANNA"]);
  });
  it("supports Unicode, apostrophes and hyphens", () => {
    expect(
      extractPeopleFromPdfText(
        "Имя гостя: Élodie O’Connor\nGuest name: Anna-Maria Ivanova",
      ),
    ).toEqual(["Élodie O’Connor", "Anna-Maria Ivanova"]);
  });
  it("accepts a single written name only in an explicit name field", () => {
    expect(
      extractPeopleFromPdfText("Guest name: 李明\nPassenger name: Mika"),
    ).toEqual(["李明", "Mika"]);
    expect(
      extractPeopleFromPdfText("PASSENGER / DOCUMENT NO.\nMika 123456"),
    ).toEqual([]);
  });
  it("does not infer people from an unlabelled name or birth date", () => {
    expect(
      extractPeopleFromPdfText(
        "IVANOVA ANNA\n01.01.1990\nElectronic ticket\n123456789",
      ),
    ).toEqual([]);
  });
  it("ignores support prose, staff and issuer fields", () => {
    expect(
      extractPeopleFromPdfText(
        "Passengers must provide a valid ID.\nAnna Ivanova\nBooking agent: Roman Petrov\nIssued by: Anna Ivanova\nИмя сотрудника: Иван Петров",
      ),
    ).toEqual([]);
  });
  it("does not treat unrelated table headers as passenger names", () => {
    expect(
      extractPeopleFromPdfText(
        "Passenger / Document No.\nEconomy Class\nTicket Number\nDeparture Arrival",
      ),
    ).toEqual([]);
  });
  it("rejects contacts, identifiers, links and overlong names", () => {
    expect(
      extractPeopleFromPdfText(
        `Guest name: Anna ivanova@example.invalid\nGuest name: https://example.invalid\nGuest name: 123456789\nGuest name: ${"A".repeat(61)} Ivanova`,
      ),
    ).toEqual([]);
  });
  it("does not read names from a distant line beyond the labelled window", () => {
    expect(
      extractPeopleFromPdfText(
        "Passenger / Document No.\n\n---\nFlight information\nAnna Ivanova 1234567",
      ),
    ).toEqual([]);
  });
  it("rejects an oversized document rather than extracting a partial list", () => {
    expect(
      extractPeopleFromPdfText(
        "Guest name: Anna Ivanova\n" + "a".repeat(40_000),
      ),
    ).toEqual([]);
  });
  it("rejects a list exceeding fifty unique candidates", () => {
    const text = Array.from(
      { length: 51 },
      (_, i) =>
        `Guest name: Anna ${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}nov`,
    ).join("\n");
    expect(extractPeopleFromPdfText(text)).toEqual([]);
  });
});
