import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
describe("deployment paths", () => {
  it("keeps root paths for local hosting", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    vi.stubEnv("NEXT_PUBLIC_STATIC_EXPORT", "");
    const deployment = await import("./deployment");
    expect(deployment.publicPath("/sw.js")).toBe("/sw.js");
    expect(deployment.STATIC_HOSTING).toBe(false);
  });
  it("prefixes assets and the home link for a repository Pages site", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/Vmeste");
    vi.stubEnv("NEXT_PUBLIC_STATIC_EXPORT", "true");
    const deployment = await import("./deployment");
    expect(deployment.publicPath("/sw.js")).toBe("/Vmeste/sw.js");
    expect(deployment.publicPath("/")).toBe("/Vmeste/");
    expect(deployment.STATIC_HOSTING).toBe(true);
  });
});
