/** The explicit line keeps the existing booking JSON/SQL contract compatible. */
export function normalizePersonName(name: string): string {
  return cleanName(name).toLocaleLowerCase("ru");
}

/** Full words only; no fuzzy spelling, missing words or inferred initials. */
export function personNameOrderKey(name: string): string {
  const exact = normalizePersonName(name);
  const words = exact.replace(/\//g, " ").split(/\s+/u).filter(Boolean);
  const full =
    words.length >= 2 &&
    words.every(
      (word) =>
        /^[\p{L}\p{M}\p{Pd}'’]+$/u.test(word) &&
        (word.match(/\p{L}/gu)?.length ?? 0) >= 2,
    );
  return full ? `full:${words.sort().join(" ")}` : `exact:${exact}`;
}

export function matchingPersonIds(
  name: string,
  members: readonly { id: string; name: string }[],
  aliases: readonly { name: string; memberId: string }[] = [],
): string[] {
  const key = personNameOrderKey(name);
  const existingIds = new Set(members.map((member) => member.id));
  const matches = new Set(
    members
      .filter((member) => personNameOrderKey(member.name) === key)
      .map((member) => member.id),
  );
  for (const alias of aliases) {
    if (
      existingIds.has(alias.memberId) &&
      personNameOrderKey(alias.name) === key
    )
      matches.add(alias.memberId);
  }
  return [...matches];
}

function cleanName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function readPeople(details: string): {
  names: string[];
  error: string | null;
} {
  const names = new Map<string, string>();
  for (const line of details.split(/\r?\n/)) {
    const match = /^Участники:\s*(.*?)\s*$/iu.exec(line.trim());
    if (!match || !match[1]) continue;
    for (const raw of match[1].split(";")) {
      const name = cleanName(raw);
      if (
        !name ||
        name.length > 60 ||
        !/\p{L}/u.test(name) ||
        !/^[\p{L}\p{M}\p{Pd} .'’/]+$/u.test(name)
      ) {
        return {
          names: [],
          error:
            "Проверьте имена участников из документа: допустимы имена до 60 символов без номеров и контактов.",
        };
      }
      names.set(
        normalizePersonName(name),
        names.get(normalizePersonName(name)) ?? name,
      );
      if (names.size > 50) {
        return {
          names: [],
          error:
            "В одной поездке можно сохранить до 50 участников. Проверьте список в документе.",
        };
      }
    }
  }
  return { names: [...names.values()], error: null };
}

/** Safe to render: malformed explicit lists stay available for manual review. */
export function documentPeople(details: string): string[] {
  return readPeople(details).names;
}

export function documentPeopleError(details: string): string | null {
  return readPeople(details).error;
}
