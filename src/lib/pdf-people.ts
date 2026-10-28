import { documentPeople, normalizePersonName } from "./document-people";

const personToken = "[\\p{L}\\p{M}.'’\\p{Pd}]+";
const personField = `(${personToken}(?: ${personToken}){0,2})`;
const russianFields = new RegExp(
  `^${personField} \\(Фамилия\\) ${personField} \\(Имя и отчество\\)`,
  "iu",
);
const englishFields = new RegExp(
  `^${personField} \\(First name\\) ${personField} \\(Last name\\)`,
  "iu",
);
const forbiddenWords =
  /\b(?:passenger|passengers|document|ticket|number|reference|economy|class|departure|arrival|flight|flights|booking|agent|issued|passport|email)\b|(?:пассажир|документ|билет|номер|гостей|сотрудник|отправление|прибытие)/iu;

function candidate(raw: string, allowSingle = false): string | null {
  const name = raw
    .replace(/^(?:Mr|Mrs|Ms|Miss|Mstr|Dr)\.?\s+/iu, "")
    .split(/\s*\/\s*(?=[A-Za-z]?\d)|\s+(?=[A-Za-z]?\d)/u)[0]
    .trim();
  if (
    name.split(/\s+/u).length < (allowSingle ? 1 : 2) ||
    name.split(/\s+/u).length > 5 ||
    forbiddenWords.test(name)
  )
    return null;
  const validated = documentPeople(`Участники: ${name}`);
  return validated.length === 1 ? validated[0] : null;
}

/** Candidates only: labelled text, never filenames, unlabelled capitals or OCR guesses. */
export function extractPeopleFromPdfText(text: string): string[] {
  if (text.length > 40_000) return [];
  const lines = text
    .normalize("NFKC")
    .replace(/[ \t\u00a0]+/gu, " ")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const names = new Map<string, string>();
  function add(raw: string, allowSingle = false) {
    const name = candidate(raw, allowSingle);
    if (name && !names.has(normalizePersonName(name)))
      names.set(normalizePersonName(name), name);
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const field =
      /^(?:(?:Имя|ФИО) (?:гостя|пассажира)|(?:Guest|Passenger) name)\s*:\s*(.*)$/iu.exec(
        line,
      );
    if (field) {
      add(field[1] || lines[index + 1] || "", true);
    }

    // Some itinerary templates print labelled first/last fields across several lines.
    const joined = lines.slice(index, index + 3).join(" ");
    const separated = russianFields.exec(joined) ?? englishFields.exec(joined);
    if (separated) add(`${separated[1]} ${separated[2]}`);

    const documentHeader =
      /^(?:ПАССАЖИР|PASSENGER)\s*\/\s*(?:ДОКУМЕНТ|DOCUMENT(?: NO\.?)?)$/iu.test(
        line,
      );
    const tableHeader =
      /^(?:Пассажиры\s*\/\s*Passengers|Пассажир и номер эл\. билета|Passenger & E-?ticket No\.?)$/iu.test(
        line,
      );
    if (!documentHeader && !tableHeader) continue;

    const windowEnd = Math.min(lines.length, index + (documentHeader ? 2 : 11));
    for (let row = index + 1; row < windowEnd; row++) {
      const value = lines[row];
      if (
        tableHeader &&
        /^(?:Документ\s+Номер билета|Document\s+Ticket (?:number|no\.?)|Полное имя.*)$/iu.test(
          value,
        )
      )
        continue;
      // Tables have identifying numeric columns or title prefixes. Requiring this
      // prevents addresses, routes and explanatory prose being read as people.
      if (
        !/\d/u.test(value) &&
        !/^(?:Mr|Mrs|Ms|Miss|Mstr|Dr)\.?\s+/iu.test(value)
      )
        break;
      const name = candidate(value);
      if (!name) break;
      add(name);
    }
    if (names.size > 50) return [];
  }
  return names.size > 50 ? [] : [...names.values()];
}
