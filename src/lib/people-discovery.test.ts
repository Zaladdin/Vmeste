import { describe, expect, it } from "vitest";
import {
  groupDiscoveredPeople,
  remainingDocumentPeople,
  existingDiscoveryMember,
} from "./people-discovery";
describe("people discovery confirmation groups", () => {
  it("keeps unconfirmed names after a partial confirmation", () => {
    expect(
      remainingDocumentPeople(
        ["IVANOVA ANNA", "IVANOV IVAN"],
        ["Anna Ivanova"],
      ),
    ).toEqual(["IVANOV IVAN"]);
  });
  it("reuses a confirmed self alias when a later document reverses name order", () => {
    const [group] = groupDiscoveredPeople([
      { documentId: "b", names: ["ANNA IVANOVA"] },
    ]);
    expect(
      existingDiscoveryMember(
        group,
        [{ id: "self", name: "Я" }],
        [{ people: [{ name: "IVANOVA ANNA", memberId: "self" }] }],
      ),
    ).toBe("self");
  });
  it("groups full-name order variants for explicit confirmation, retaining all sources", () => {
    const groups = groupDiscoveredPeople([
      { documentId: "a", names: ["IVANOVA ANNA", "IVANOV IVAN"] },
      { documentId: "b", names: ["Anna Ivanova", "IVANOVA ANNA"] },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].documentIds).toEqual(["a", "b"]);
    expect(groups[0].variants).toEqual(["IVANOVA ANNA", "Anna Ivanova"]);
  });
  it("keeps a short name and a full or differently spelled name separate", () => {
    expect(
      groupDiscoveredPeople([
        { documentId: "a", names: ["Anna", "Anna Ivanova", "Anna Ivanoff"] },
      ]),
    ).toHaveLength(3);
  });
});
