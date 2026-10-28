import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  text: vi.fn(),
  images: vi.fn(),
  run: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock("./document-images", () => ({
  prepareDocumentText: mocks.text,
  prepareDocumentImages: mocks.images,
}));
vi.mock("./codex-recognition", () => ({ recognizeWithCodex: mocks.run }));
vi.mock("node:fs/promises", () => ({ mkdir: mocks.mkdir }));
import { recognizeCodexDocument } from "./codex-document";
const draft = {
  kind: "flight",
  title: "GYD → IST",
  date: "2027-05-11",
  time: "09:30",
  timeZone: "Asia/Baku",
  endDate: "2027-05-11",
  endTime: "11:40",
  endTimeZone: "Europe/Istanbul",
  location: "IST",
  details: "",
  needsReview: false,
  reviewReason: null,
};
const result = {
  events: [draft],
  warnings: [],
  usage: {
    provider: "codex",
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 0,
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.text.mockResolvedValue("Complete PDF text");
  mocks.images.mockResolvedValue(["page.png"]);
  mocks.run.mockResolvedValue(result);
});
describe("text-first PDF recognition", () => {
  it("uses text without rendering images for a complete result", async () => {
    expect(
      await recognizeCodexDocument(
        new File(["pdf"], "a.pdf", { type: "application/pdf" }),
        "workspace",
        "instructions",
      ),
    ).toEqual(result);
    expect(mocks.images).not.toHaveBeenCalled();
    expect(mocks.run.mock.calls[0][0]).toEqual([]);
    expect(mocks.run.mock.calls[0][4]).toBe("Complete PDF text");
  });
  it("uses images directly for a scan without a usable text layer", async () => {
    mocks.text.mockResolvedValue(null);
    await recognizeCodexDocument(
      new File(["pdf"], "a.pdf", { type: "application/pdf" }),
      "workspace",
      "instructions",
    );
    expect(mocks.images).toHaveBeenCalledOnce();
    expect(mocks.run).toHaveBeenCalledOnce();
  });
  it.each([
    { events: [], warnings: [] },
    { events: [{ ...draft, needsReview: true }], warnings: [] },
    { events: [{ ...draft, endTime: null }], warnings: [] },
    { events: [{ ...draft, time: "28:00" }], warnings: [] },
  ])(
    "falls back for incomplete text results and sums both requests",
    async (partial) => {
      mocks.run
        .mockResolvedValueOnce({ ...partial, usage: result.usage })
        .mockResolvedValueOnce(result);
      const actual = await recognizeCodexDocument(
        new File(["pdf"], "a.pdf", { type: "application/pdf" }),
        "workspace",
        "instructions",
      );
      expect(mocks.run).toHaveBeenCalledTimes(2);
      expect(actual.events).toEqual(result.events);
      expect(actual.usage).toMatchObject({
        inputTokens: 200,
        outputTokens: 40,
        cachedInputTokens: 0,
      });
    },
  );
  it("does not report partial token totals when one attempt has no counters", async () => {
    mocks.run
      .mockResolvedValueOnce({ events: [], warnings: [] })
      .mockResolvedValueOnce(result);
    expect(
      (
        await recognizeCodexDocument(
          new File(["pdf"], "a.pdf", { type: "application/pdf" }),
          "workspace",
          "instructions",
        )
      ).usage,
    ).toBeUndefined();
  });
  it("does not retry account errors as image recognition", async () => {
    mocks.run.mockRejectedValueOnce(new Error("quota"));
    await expect(
      recognizeCodexDocument(
        new File(["pdf"], "a.pdf", { type: "application/pdf" }),
        "workspace",
        "instructions",
      ),
    ).rejects.toThrow("quota");
    expect(mocks.images).not.toHaveBeenCalled();
  });
});
