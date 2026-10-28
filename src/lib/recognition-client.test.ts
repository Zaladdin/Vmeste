import { afterEach, describe, expect, it, vi } from "vitest";
import { fileFingerprint, recognizeFile } from "./recognition-client";
import type { StoredDocument } from "./model";

const document: StoredDocument = {
  id: "test",
  tripId: "trip",
  name: "ticket.pdf",
  type: "application/pdf",
  size: 3,
  blob: new Blob(["pdf"], { type: "application/pdf" }),
};
describe("browser recognition client", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("fingerprints content independently of filenames", async () => {
    expect(await fileFingerprint(document.blob)).toMatch(/^[0-9a-f]{64}$/);
    expect(await fileFingerprint(document.blob)).toBe(
      await fileFingerprint(new Blob(["pdf"])),
    );
    expect(await fileFingerprint(document.blob)).not.toBe(
      await fileFingerprint(new Blob(["another file"])),
    );
  });
  it("sends a multipart file with intent header, never an API key", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ events: [], warnings: [] }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(await recognizeFile(document)).toEqual({ events: [], warnings: [] });
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/recognize");
    expect(init.headers).toEqual({ "x-vmeste-recognition": "1" });
    expect((init.body as FormData).get("file")).toBeInstanceOf(File);
  });
  it("does not accept malformed AI data as a successful recognition", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ events: [{ title: "invented" }], warnings: [] }),
      ),
    );
    await expect(recognizeFile(document)).rejects.toThrow("проверить");
  });
  it("keeps network failures actionable without exposing raw exceptions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("raw secret exception");
      }),
    );
    await expect(recognizeFile(document)).rejects.toThrow("Файл сохранён");
  });
  it("handles a timeout with an explicit retry message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("timeout", "TimeoutError");
      }),
    );
    await expect(recognizeFile(document)).rejects.toThrow(
      "слишком много времени",
    );
  });
  it("surfaces safe server errors and handles invalid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "Баланс API исчерпан" }, { status: 503 }),
      ),
    );
    await expect(recognizeFile(document)).rejects.toThrow(
      "Баланс API исчерпан",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 500 })),
    );
    await expect(recognizeFile(document)).rejects.toThrow("непонятный ответ");
  });
});
