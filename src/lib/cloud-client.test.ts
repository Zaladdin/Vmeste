import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  getUser: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  rpc: vi.fn(),
  maybe: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.create }));
const userId = "00000000-0000-4000-8000-000000000001",
  jobId = "00000000-0000-4000-8000-000000000002",
  attemptId = "00000000-0000-4000-8000-000000000003",
  documentId = "00000000-0000-4000-8000-000000000004",
  tripId = "00000000-0000-4000-8000-000000000005";
const job = {
  id: jobId,
  user_id: userId,
  attempt_id: attemptId,
  document_id: documentId,
  trip_id: tripId,
  status: "queued",
  result: null,
  error: null,
};
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "sb_publishable_test_public_key",
  );
  mocks.getUser.mockResolvedValue({
    data: { user: { id: userId } },
    error: null,
  });
  mocks.upload.mockResolvedValue({ error: null });
  mocks.download.mockResolvedValue({
    data: null,
    error: { statusCode: "404" },
  });
  mocks.rpc.mockResolvedValue({ data: [job], error: null });
  mocks.maybe.mockResolvedValue({ data: null, error: null });
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: mocks.maybe,
  };
  mocks.create.mockReturnValue({
    auth: { getUser: mocks.getUser },
    storage: {
      from: () => ({ upload: mocks.upload, download: mocks.download }),
    },
    rpc: mocks.rpc,
    from: () => chain,
  });
});
describe("private cloud queue client", () => {
  it("recovers a lost upload reply only when the existing object's bytes match", async () => {
    const { fileFingerprint } = await import("./recognition-client");
    const blob = new Blob(["pdf"]);
    const document = {
      id: documentId,
      tripId,
      name: "ticket.pdf",
      type: "application/pdf",
      size: 3,
      blob,
      fingerprint: await fileFingerprint(blob),
    };
    mocks.upload.mockResolvedValue({ error: { statusCode: "400" } });
    mocks.download.mockResolvedValue({ data: blob, error: null });
    const cloud = await import("./cloud-client");
    expect(
      await cloud.enqueueCloudDocument(document, attemptId, jobId, userId),
    ).toEqual(job);
    expect(mocks.rpc).toHaveBeenCalledOnce();
    mocks.rpc.mockClear();
    mocks.download.mockResolvedValue({ data: new Blob(["bad"]), error: null });
    await expect(
      cloud.enqueueCloudDocument(document, attemptId, jobId, userId),
    ).rejects.toThrow(/загрузить/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("preserves safe server failure messages and hides unexpected provider details", async () => {
    const { cloudFailureMessage } = await import("./cloud-client");
    expect(
      cloudFailureMessage(
        "Дневной лимит распознавания исчерпан. Повторите позже.",
      ),
    ).toBe("Дневной лимит распознавания исчерпан. Повторите позже.");
    expect(
      cloudFailureMessage("raw token secret-provider-detail"),
    ).not.toContain("secret-provider-detail");
  });
  it("does not instantiate a client when cloud config is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    const cloud = await import("./cloud-client");
    expect(cloud.CLOUD_CONFIGURED).toBe(false);
    expect(cloud.getCloudClient()).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("uploads a private fixed path and enqueues the same idempotency binding", async () => {
    const cloud = await import("./cloud-client");
    const document = {
      id: documentId,
      tripId,
      name: "ticket.pdf",
      type: "application/pdf",
      size: 3,
      blob: new Blob(["pdf"]),
      fingerprint: "a".repeat(64),
    };
    expect(
      await cloud.enqueueCloudDocument(document, attemptId, jobId, userId),
    ).toEqual(job);
    expect(mocks.upload).toHaveBeenCalledWith(
      `${userId}/${jobId}/document`,
      document.blob,
      { contentType: "application/pdf", upsert: false },
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "enqueue_recognition_job",
      expect.objectContaining({
        p_id: jobId,
        p_attempt_id: attemptId,
        p_document_id: documentId,
        p_fingerprint: document.fingerprint,
      }),
    );
  });
  it("reuses an existing matching job without a second upload", async () => {
    mocks.maybe.mockResolvedValue({ data: job, error: null });
    const cloud = await import("./cloud-client");
    await cloud.enqueueCloudDocument(
      {
        id: documentId,
        tripId,
        name: "a",
        type: "application/pdf",
        size: 3,
        blob: new Blob(["pdf"]),
        fingerprint: "a".repeat(64),
      },
      attemptId,
      jobId,
      userId,
    );
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects another account before uploading", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: tripId } },
      error: null,
    });
    const cloud = await import("./cloud-client");
    await expect(
      cloud.enqueueCloudDocument(
        {
          id: documentId,
          tripId,
          name: "a",
          type: "application/pdf",
          size: 3,
          blob: new Blob(["pdf"]),
          fingerprint: "a".repeat(64),
        },
        attemptId,
        jobId,
        userId,
      ),
    ).rejects.toThrow(/аккаунт/);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
