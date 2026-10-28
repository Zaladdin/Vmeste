import { createHash } from "node:crypto";
import { z } from "zod";
const mime = z.enum([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const jobSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  worker_token: z.uuid(),
  object_path: z.string(),
  name: z.string().min(1).max(255),
  mime_type: mime,
  size: z
    .number()
    .int()
    .min(1)
    .max(20 * 1024 * 1024),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.literal("processing"),
});

export function localServerOrigin(value = "http://127.0.0.1:3000") {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Адрес обработчика должен быть локальным origin без пути.");
  return url.origin;
}

export async function processNextCloudJob(
  client,
  userId,
  { fetcher = fetch, origin = "http://127.0.0.1:3000", signal } = {},
) {
  origin = localServerOrigin(origin);
  if (signal?.aborted) throw new Error("Обработчик остановлен.");
  const claimed = await client.rpc("claim_recognition_job");
  if (claimed.error)
    throw new Error("Не удалось получить задание из закрытой очереди.");
  if (Array.isArray(claimed.data) && claimed.data.length === 0) return "idle";
  const parsed = jobSchema.safeParse(
    Array.isArray(claimed.data) && claimed.data.length === 1
      ? claimed.data[0]
      : null,
  );
  if (
    !parsed.success ||
    parsed.data.user_id !== userId ||
    parsed.data.object_path !== `${userId}/${parsed.data.id}/document`
  )
    throw new Error("Получено некорректное задание. Обработка остановлена.");
  const job = parsed.data;
  let result;
  let failureCode = "recognition_failed";
  try {
    const download = await client.storage
      .from("vmeste-documents")
      .download(job.object_path);
    if (download.error || !download.data) {
      failureCode = "invalid_document";
      throw new Error();
    }
    const blob = download.data;
    if (blob.size !== job.size) {
      failureCode = "invalid_document";
      throw new Error();
    }
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== job.fingerprint) {
      failureCode = "invalid_document";
      throw new Error();
    }
    const form = new FormData();
    form.set(
      "file",
      new Blob([bytes], { type: job.mime_type }),
      "document" + (job.mime_type === "application/pdf" ? ".pdf" : ".image"),
    );
    const timeout = AbortSignal.timeout(240_000);
    let response;
    try {
      response = await fetcher(`${origin}/api/recognize`, {
        method: "POST",
        headers: { origin, "x-vmeste-recognition": "1" },
        body: form,
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      failureCode = "worker_unavailable";
      throw new Error();
    }
    if (!response.ok) {
      failureCode =
        response.status === 429
          ? "daily_limit"
          : [400, 413, 415, 422].includes(response.status)
            ? "invalid_document"
            : "recognition_failed";
      throw new Error();
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    let length = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 262144) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    // The loopback API validates the full booking schema; SQL validates it again.
    if (
      !result ||
      !Array.isArray(result.events) ||
      result.events.length > 50 ||
      !Array.isArray(result.warnings) ||
      result.warnings.length > 20
    )
      throw new Error();
  } catch {
    const failed = await client.rpc("fail_recognition_job", {
      p_id: job.id,
      p_worker_token: job.worker_token,
      p_error: failureCode,
    });
    if (failed.error)
      throw new Error(
        "Не удалось сохранить статус задания. Автоматический повтор отключён.",
      );
    return "failed";
  }
  // A lost completion response must never cause another paid inference attempt.
  const completed = await client.rpc("complete_recognition_job", {
    p_id: job.id,
    p_worker_token: job.worker_token,
    p_result: result,
  });
  if (completed.error)
    throw new Error(
      "Не удалось сохранить результат. Автоматический повтор отключён.",
    );
  return "completed";
}
