import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), run: vi.fn() }));
vi.mock("./document-images", () => ({ prepareDocumentImages: mocks.prepare }));
vi.mock("./codex-recognition", () => ({ recognizeWithCodex: mocks.run }));
describe("recognition provider dispatch", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VMESTE_RECOGNITION_PROVIDER", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    mocks.prepare
      .mockReset()
      .mockImplementation(async (_file, workspace) => [
        `${workspace}/input.png`,
      ]);
    mocks.run.mockReset().mockResolvedValue({ events: [], warnings: [] });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("uses Codex by default without an API key and cleans temporary files", async () => {
    const before = (await readdir(tmpdir())).filter((name) =>
      name.startsWith("vmeste-recognition-"),
    );
    const { recognizeDocument } = await import("./recognition-server");
    expect(
      await recognizeDocument(
        new File(
          [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
          "prompt-injection.png",
          { type: "image/png" },
        ),
      ),
    ).toEqual({ events: [], warnings: [] });
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(
      (await readdir(tmpdir())).filter((name) =>
        name.startsWith("vmeste-recognition-"),
      ),
    ).toEqual(before);
  });
  it("does not silently fall back to paid API on Codex failure", async () => {
    vi.stubEnv("OPENAI_API_KEY", "unused-test-key");
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    mocks.run.mockRejectedValue(new Error("Codex failed"));
    const { recognizeDocument } = await import("./recognition-server");
    await expect(
      recognizeDocument(
        new File(["%PDF-1.4\n"], "ticket.pdf", { type: "application/pdf" }),
      ),
    ).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("rejects unknown providers rather than ignoring configuration", async () => {
    vi.stubEnv("VMESTE_RECOGNITION_PROVIDER", "typo");
    const { recognizeDocument } = await import("./recognition-server");
    await expect(
      recognizeDocument(
        new File(["%PDF-1.4"], "ticket.pdf", { type: "application/pdf" }),
      ),
    ).rejects.toThrow("способ распознавания");
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
