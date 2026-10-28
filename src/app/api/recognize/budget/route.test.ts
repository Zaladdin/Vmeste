import { beforeEach, describe, expect, it, vi } from "vitest";
const status = {
  day: "2026-10-28",
  limit: 10,
  used: 0,
  remaining: 10,
  resetAt: "2026-10-29T00:00:00.000Z",
  estimate: { model: "gpt-6.1-sol", credits: 0.65 },
};
const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("../../../../lib/recognition-budget", () => ({
  getRecognitionBudget: mocks.get,
  setRecognitionDailyLimit: mocks.set,
}));
import { GET, PATCH } from "./route";
const origin = "http://127.0.0.1:3000";
function patch(body: unknown, headers: Record<string, string> = {}) {
  return new Request(origin + "/api/recognize/budget", {
    method: "PATCH",
    headers: {
      origin,
      "x-vmeste-recognition": "1",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(status);
  mocks.set.mockResolvedValue({ ...status, limit: 2, remaining: 2 });
});
describe("recognition budget route", () => {
  it("returns uncached status and lets local requests set a validated limit", async () => {
    const response = await GET(new Request(origin + "/api/recognize/budget"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual(status);
    expect((await PATCH(patch({ limit: 2 }))).status).toBe(200);
    expect(mocks.set).toHaveBeenCalledWith(2);
  });
  it.each<Record<string, string>>([
    { origin: "https://evil.example" },
    { "x-vmeste-recognition": "0" },
    { host: "127.0.0.1:3000@evil.example" },
  ])("rejects foreign mutation %j", async (headers) => {
    expect((await PATCH(patch({ limit: 100 }, headers))).status).toBe(403);
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it.each([
    { limit: 101 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: "10" },
    { limit: 10, used: 0 },
  ])("rejects invalid mutation %j", async (body) => {
    expect((await PATCH(patch(body))).status).toBe(400);
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it("rejects oversized bodies without trusting content-length", async () => {
    expect(
      (await PATCH(patch({ limit: 2, padding: "a".repeat(1024) }))).status,
    ).toBe(413);
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
