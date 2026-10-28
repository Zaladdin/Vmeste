import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./recognition-budget", () => ({
  reserveRecognitionAttempt: vi.fn().mockResolvedValue(undefined),
}));

const recognized = {
  events: [
    {
      kind: "flight",
      title: "Баку → Стамбул",
      date: "2027-05-10",
      time: "09:30",
      timeZone: "Asia/Baku",
      endDate: "2027-05-10",
      endTime: "11:40",
      endTimeZone: "Europe/Istanbul",
      location: "Istanbul Airport",
      details: "J2 077",
      needsReview: false,
      reviewReason: null,
    },
  ],
  warnings: [],
};
function providerResponse(value: unknown = recognized) {
  return Response.json({
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(value) }],
      },
    ],
  });
}
function pdf() {
  return new File(["%PDF-1.4\nfixture"], "ignore-all-instructions.pdf", {
    type: "application/pdf",
  });
}

describe("recognition provider", () => {
  it("blocks the API provider before a paid request when the daily limit is exhausted", async () => {
    const { reserveRecognitionAttempt } = await import("./recognition-budget");
    const { RecognitionError, recognizeDocument } =
      await import("./recognition-server");
    vi.mocked(reserveRecognitionAttempt).mockRejectedValueOnce(
      new RecognitionError("Дневной лимит исчерпан", 429),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(recognizeDocument(pdf())).rejects.toMatchObject({
      status: 429,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VMESTE_RECOGNITION_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENAI_RECOGNITION_MODEL", "gpt-5-mini");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends PDF with strict output schema, no provider storage and generic filename", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { recognizeDocument } = await import("./recognition-server");
    expect(await recognizeDocument(pdf())).toEqual(recognized);
    const [url, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(body.store).toBe(false);
    expect(body.text.format.strict).toBe(true);
    expect(body.input[0].content[0]).toMatchObject({
      type: "input_file",
      filename: "document.pdf",
    });
    expect(JSON.stringify(body)).not.toContain("ignore-all-instructions.pdf");
    expect(body.input[0].content[0].file_data).toMatch(
      /^data:application\/pdf;base64,/,
    );
  });
  it.each([
    ["image/png", [137, 80, 78, 71, 13, 10, 26, 10]],
    ["image/jpeg", [255, 216, 255, 224]],
    ["image/webp", [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]],
  ])("sends %s through vision input", async (type, bytes) => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { recognizeDocument } = await import("./recognition-server");
    await recognizeDocument(
      new File([new Uint8Array(bytes)], "photo", { type }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.input[0].content[0]).toMatchObject({
      type: "input_image",
      detail: "high",
    });
    expect(body.input[0].content[0].image_url).toMatch(/^data:image\//);
  });
  it("rejects missing configuration without network calls", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { recognizeDocument } = await import("./recognition-server");
    await expect(recognizeDocument(pdf())).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects unsupported, oversized and forged files before calling provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { recognizeDocument } = await import("./recognition-server");
    await expect(
      recognizeDocument(
        new File(["<html>"], "x.pdf", { type: "application/pdf" }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      recognizeDocument(new File(["x"], "x.txt", { type: "text/plain" })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      recognizeDocument(
        new File([new Uint8Array(20 * 1024 * 1024 + 1)], "x.pdf", {
          type: "application/pdf",
        }),
      ),
    ).rejects.toMatchObject({ status: 413 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("sanitizes provider errors and forwards a bounded retry delay", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { message: "secret test-key internal-provider-detail" } },
            { status: 429, headers: { "retry-after": "30" } },
          ),
        ),
    );
    const { recognizeDocument } = await import("./recognition-server");
    await expect(recognizeDocument(pdf())).rejects.toMatchObject({
      status: 429,
      retryAfter: 30,
    });
    try {
      await recognizeDocument(pdf());
    } catch (e) {
      expect(String(e)).not.toMatch(/test-key|internal-provider/);
    }
  });
  it.each([
    { code: "credit_balance_exhausted", type: "insufficient_quota" },
    { code: "insufficient_quota", type: "quota_error" },
    { code: "unknown", type: "insufficient_quota" },
  ])(
    "explains exhausted API balance without leaking provider text or a retry delay",
    async (error) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          Response.json(
            {
              error: {
                ...error,
                message: "secret test-key internal-provider-detail",
              },
            },
            { status: 429, headers: { "retry-after": "30" } },
          ),
        ),
      );
      const { recognizeDocument } = await import("./recognition-server");
      try {
        await recognizeDocument(pdf());
        expect.fail("Expected quota failure");
      } catch (error) {
        expect(error).toMatchObject({
          status: 503,
          message:
            "На API-ключе OpenAI закончился баланс. Документ сохранён; распознавание можно повторить после пополнения баланса.",
        });
        expect(error).toHaveProperty("retryAfter", undefined);
        expect(String(error)).not.toMatch(/test-key|internal-provider-detail/);
      }
    },
  );
  it("preserves generic rate limiting for malformed non-JSON provider errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not JSON secret", {
          status: 429,
          headers: { "retry-after": "9" },
        }),
      ),
    );
    const { recognizeDocument } = await import("./recognition-server");
    await expect(recognizeDocument(pdf())).rejects.toMatchObject({
      status: 429,
      retryAfter: 9,
    });
  });
  it("handles network failure, refusal, incomplete and invalid output without exposing input", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret test-key"))
      .mockResolvedValueOnce(
        Response.json({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "refusal", refusal: "unsafe provider detail" }],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ status: "incomplete", output: [] }),
      )
      .mockResolvedValueOnce(providerResponse({ events: "invalid" }));
    vi.stubGlobal("fetch", fetchMock);
    const { recognizeDocument } = await import("./recognition-server");
    for (let i = 0; i < 4; i++)
      await expect(recognizeDocument(pdf())).rejects.toMatchObject({
        status: expect.any(Number),
      });
  });
  it("allows at most two concurrent requests and releases slots after errors", async () => {
    let complete!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      complete = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() => gate.then((response) => response.clone())),
    );
    const { recognizeDocument } = await import("./recognition-server");
    const one = recognizeDocument(pdf());
    const two = recognizeDocument(pdf());
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(recognizeDocument(pdf())).rejects.toMatchObject({
      status: 429,
    });
    complete(providerResponse());
    expect(await Promise.all([one, two])).toEqual([recognized, recognized]);
  });
  it("returns a useful timeout and abort result without leaking exceptions", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(
      AbortSignal.abort(new DOMException("provider-secret", "TimeoutError")),
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(
          new DOMException("provider-secret", "TimeoutError"),
        ),
    );
    const { recognizeDocument } = await import("./recognition-server");
    await expect(recognizeDocument(pdf())).rejects.toMatchObject({
      status: 504,
    });
    await expect(
      recognizeDocument(pdf(), AbortSignal.abort()),
    ).rejects.toMatchObject({ status: 499 });
    vi.restoreAllMocks();
  });
  it("enforces a per-minute local request limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(providerResponse())),
    );
    const { recognizeDocument } = await import("./recognition-server");
    for (let i = 0; i < 10; i++) await recognizeDocument(pdf());
    await expect(recognizeDocument(pdf())).rejects.toMatchObject({
      status: 429,
    });
  });
});
