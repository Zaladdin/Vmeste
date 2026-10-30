import {
  normalizePersonName,
  personNameOrderKey,
  matchingPersonIds,
} from "./document-people";
export type DiscoveredPerson = {
  key: string;
  name: string;
  variants: string[];
  documentIds: string[];
};
function orderKey(name: string): string {
  return personNameOrderKey(name);
}
export function remainingDocumentPeople(
  names: string[],
  confirmed: string[],
): string[] {
  const known = new Set(confirmed.map(orderKey));
  return names.filter((name) => !known.has(orderKey(name)));
}
export function existingDiscoveryMember(
  group: DiscoveredPerson,
  members: { id: string; name: string }[],
  documents: { people?: { name: string; memberId: string }[] }[],
): string | undefined {
  const aliases = documents.flatMap((document) => document.people ?? []);
  const matches = new Set(
    group.variants.flatMap((name) => matchingPersonIds(name, members, aliases)),
  );
  return matches.size === 1 ? [...matches][0] : undefined;
}

/** Only proposes order variants as a group; every group still needs user confirmation. */
export function groupDiscoveredPeople(
  documents: { documentId: string; names: string[] }[],
): DiscoveredPerson[] {
  const groups = new Map<string, DiscoveredPerson>();
  for (const document of documents) {
    for (const name of document.names) {
      const normalized = normalizePersonName(name);
      const key = orderKey(name);
      let group = groups.get(key);
      if (!group) {
        group = { key, name, variants: [], documentIds: [] };
        groups.set(key, group);
      }
      if (
        !group.variants.some(
          (variant) => normalizePersonName(variant) === normalized,
        )
      )
        group.variants.push(name);
      if (!group.documentIds.includes(document.documentId))
        group.documentIds.push(document.documentId);
    }
  }
  return [...groups.values()];
}
