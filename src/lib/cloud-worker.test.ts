import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  processNextCloudJob,
  localServerOrigin,
} from "../../scripts/cloud-worker-core.mjs";
const owner = "11111111-1111-4111-8111-111111111111",
  id = "22222222-2222-4222-8222-222222222222",
  token = "33333333-3333-4333-8333-333333333333";
const bytes = Buffer.from("%PDF-1.4\nfixture");
const job = {
  id,
  user_id: owner,
  worker_token: token,
  object_path: `${owner}/${id}/document`,
  name: "test.pdf",
  mime_type: "application/pdf",
  size: bytes.length,
  fingerprint: createHash("sha256").update(bytes).digest("hex"),
  status: "processing",
};
let client: any, fetcher: any;
beforeEach(() => {
  client = {
    rpc: vi
      .fn()
      .mockImplementation(async (name: string) => ({
        data: name === "claim_recognition_job" ? [job] : [],
        error: null,
      })),
    storage: {
      from: vi
        .fn()
        .mockReturnValue({
          download: vi
            .fn()
            .mockResolvedValue({ data: new Blob([bytes]), error: null }),
        }),
    },
  };
  fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ events: [], warnings: [] }));
});
describe("private local recognition worker", () => {
  it("does nothing when no job is queued", async () => {
    client.rpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await processNextCloudJob(client, owner, { fetcher })).toBe("idle");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("downloads only own file, checks hash, invokes loopback and completes once", async () => {
    expect(await processNextCloudJob(client, owner, { fetcher })).toBe(
      "completed",
    );
    expect(fetcher.mock.calls[0][0]).toBe(
      "http://127.0.0.1:3000/api/recognize",
    );
    expect(fetcher.mock.calls[0][1].headers.origin).toBe(
      "http://127.0.0.1:3000",
    );
    expect(client.rpc).toHaveBeenLastCalledWith("complete_recognition_job", {
      p_id: id,
      p_worker_token: token,
      p_result: { events: [], warnings: [] },
    });
  });
  it("refuses jobs owned by another account before download or model", async () => {
    client.rpc.mockResolvedValueOnce({
      data: [{ ...job, user_id: token }],
      error: null,
    });
    await expect(
      processNextCloudJob(client, owner, { fetcher }),
    ).rejects.toThrow(/задание/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects mismatching bytes without calling the model", async () => {
    client.storage
      .from()
      .download.mockResolvedValueOnce({
        data: new Blob(["changed"]),
        error: null,
      });
    expect(await processNextCloudJob(client, owner, { fetcher })).toBe(
      "failed",
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenLastCalledWith("fail_recognition_job", {
      p_id: id,
      p_worker_token: token,
      p_error: "invalid_document",
    });
  });
  it("does not rerun paid inference when completion persistence fails", async () => {
    client.rpc.mockImplementation(async (name: string) => ({
      data: name === "claim_recognition_job" ? [job] : [],
      error: name === "complete_recognition_job" ? new Error("secret") : null,
    }));
    await expect(
      processNextCloudJob(client, owner, { fetcher }),
    ).rejects.toThrow(/сохранить/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      client.rpc.mock.calls.filter((x: any) => x[0] === "fail_recognition_job"),
    ).toHaveLength(0);
  });
  it("maps a server limit error to a fixed code without leaking provider text", async () => {
    fetcher.mockResolvedValueOnce(
      Response.json({ error: "secret-api rawtrace" }, { status: 429 }),
    );
    expect(await processNextCloudJob(client, owner, { fetcher })).toBe(
      "failed",
    );
    expect(client.rpc).toHaveBeenLastCalledWith("fail_recognition_job", {
      p_id: id,
      p_worker_token: token,
      p_error: "daily_limit",
    });
  });
  it.each([
    "https://evil.example",
    "http://localhost:3000/path",
    "http://user:pass@127.0.0.1:3000",
  ])("rejects external or malformed local server %s", (value) => {
    expect(() => localServerOrigin(value)).toThrow();
  });
});
