import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../lib/recognition-budget", () => ({
  reserveRecognitionAttempt: vi.fn().mockResolvedValue(undefined),
}));
const recognized = { events: [], warnings: [] };
function request(headers: Record<string, string> = {}) {
  const form = new FormData();
  form.set(
    "file",
    new File(["%PDF-1.4\nfixture"], "ticket.pdf", { type: "application/pdf" }),
  );
  return new Request("http://127.0.0.1:3000/api/recognize", {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1:3000",
      "x-vmeste-recognition": "1",
      ...headers,
    },
    body: form,
  });
}
describe("recognition route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VMESTE_RECOGNITION_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          Response.json({
            status: "completed",
            output: [
              {
                type: "message",
                content: [
                  { type: "output_text", text: JSON.stringify(recognized) },
                ],
              },
            ],
          }),
        ),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it("accepts a same-origin local multipart upload and prevents response caching", async () => {
    const { POST } = await import("./route");
    const result = await POST(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(recognized);
    expect(result.headers.get("cache-control")).toContain("no-store");
  });
  it("uses the validated actual Host when Next normalizes its internal URL to localhost", async () => {
    const { POST } = await import("./route");
    const form = new FormData();
    form.set(
      "file",
      new File(["%PDF-1.4\nfixture"], "ticket.pdf", {
        type: "application/pdf",
      }),
    );
    const local = new Request("http://localhost:3001/api/recognize", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3001",
        origin: "http://127.0.0.1:3001",
        "x-vmeste-recognition": "1",
      },
      body: form,
    });
    expect((await POST(local)).status).toBe(200);
  });
  it.each([
    "evil.example:3000",
    "127.0.0.1:3000@evil.example",
    "127.0.0.1:3000/path",
    "127.0.0.1:3000,evil.example",
    "localhost:3000?query=1",
  ])("rejects invalid or external actual Host %s", async (host) => {
    const { POST } = await import("./route");
    expect(
      (await POST(request({ host, "x-forwarded-host": "127.0.0.1:3000" })))
        .status,
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { origin: "https://evil.example", "x-vmeste-recognition": "1" },
    { origin: "http://127.0.0.1:3000", "x-vmeste-recognition": "0" },
    { origin: "", "x-vmeste-recognition": "1" },
  ])("rejects cross-origin or missing intent headers", async (headers) => {
    const { POST } = await import("./route");
    const result = await POST(request(headers));
    expect(result.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not enable a public paid endpoint", async () => {
    const { POST } = await import("./route");
    const form = new FormData();
    form.set(
      "file",
      new File(["%PDF-1.4"], "ticket.pdf", { type: "application/pdf" }),
    );
    const result = await POST(
      new Request("https://public.example/api/recognize", {
        method: "POST",
        headers: {
          origin: "https://public.example",
          "x-vmeste-recognition": "1",
        },
        body: form,
      }),
    );
    expect(result.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects declared oversized upload and missing file without calling the provider", async () => {
    const { POST } = await import("./route");
    expect(
      (await POST(request({ "content-length": String(22 * 1024 * 1024) })))
        .status,
    ).toBe(413);
    const form = new FormData();
    form.set("wrong", "no file");
    const missing = new Request("http://127.0.0.1:3000/api/recognize", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3000", "x-vmeste-recognition": "1" },
      body: form,
    });
    expect((await POST(missing)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports configuration status without leaking credentials", async () => {
    const { GET } = await import("./route");
    const result = await GET(
      new Request("http://127.0.0.1:3000/api/recognize"),
    );
    expect(await result.json()).toEqual({
      configured: true,
      provider: "openai",
    });
  });
  it("reports exhausted API balance without a misleading Retry-After header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: {
              code: "credit_balance_exhausted",
              type: "insufficient_quota",
              message: "provider-secret",
            },
          },
          { status: 429, headers: { "retry-after": "30" } },
        ),
      ),
    );
    const { POST } = await import("./route");
    const result = await POST(request());
    expect(result.status).toBe(503);
    expect(result.headers.has("retry-after")).toBe(false);
    expect(await result.json()).toEqual({
      error:
        "На API-ключе OpenAI закончился баланс. Документ сохранён; распознавание можно повторить после пополнения баланса.",
    });
  });
  it("bounds streamed multipart data even without a content-length header", async () => {
    const { POST } = await import("./route");
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(21 * 1024 * 1024 + 1));
      },
      cancel,
    });
    const streamed = new Request("http://127.0.0.1:3000/api/recognize", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3000",
        "x-vmeste-recognition": "1",
        "content-type": "multipart/form-data; boundary=fixture",
      },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect((await POST(streamed)).status).toBe(413);
    expect(cancel).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
