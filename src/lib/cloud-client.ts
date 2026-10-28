import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { StoredDocument } from "./model";
import { fileFingerprint } from "./recognition-client";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const publicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
function validPublicKey(value: string): boolean {
  if (value.startsWith("sb_publishable_") && value.length >= 20) return true;
  try {
    return JSON.parse(atob(value.split(".")[1])).role === "anon";
  } catch {
    return false;
  }
}
const validUrl = z.url().safeParse(projectUrl);
export const CLOUD_CONFIGURED =
  validUrl.success &&
  (projectUrl.startsWith("https://") ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(projectUrl)) &&
  validPublicKey(publicKey);
let client: SupabaseClient | null = null;
export function getCloudClient(): SupabaseClient | null {
  if (!CLOUD_CONFIGURED) return null;
  if (!client)
    client = createClient(projectUrl, publicKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: "vmeste-cloud-auth",
      },
      global: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: init?.signal ?? AbortSignal.timeout(30_000),
          }),
      },
    });
  return client;
}
export const cloudJobSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  attempt_id: z.uuid(),
  document_id: z.uuid(),
  trip_id: z.string().min(1).max(100),
  status: z.enum(["queued", "processing", "completed", "failed"]),
  result: z.unknown().nullable(),
  error: z.string().max(500).nullable(),
});
export type CloudJob = z.infer<typeof cloudJobSchema>;
const safeFailureMessages = new Set([
  "Дневной лимит распознавания исчерпан. Повторите позже.",
  "Не удалось прочитать документ. Загрузите оригинал PDF или изображения.",
  "Локальный обработчик недоступен. Проверьте его на компьютере.",
  "Не удалось распознать документ. Проверьте локальный обработчик и повторите попытку.",
]);
export function cloudFailureMessage(message: string | null): string {
  return message && safeFailureMessages.has(message)
    ? message
    : "Не удалось распознать документ на компьютере. Можно повторить попытку.";
}
function unavailable() {
  return new Error(
    "Не удалось связаться с облачной очередью. Проверьте подключение и настройки Supabase.",
  );
}
async function account(userId: string) {
  const sdk = getCloudClient();
  if (!sdk) throw new Error("Облачное распознавание ещё не настроено.");
  const { data, error } = await sdk.auth.getUser();
  if (error || !data.user || data.user.id !== userId)
    throw new Error("Войдите в аккаунт, из которого отправлен документ.");
  return sdk;
}
export async function readCloudJob(
  jobId: string,
  userId: string,
): Promise<CloudJob | null> {
  const sdk = await account(userId);
  const { data, error } = await sdk
    .from("recognition_jobs")
    .select("id,user_id,attempt_id,document_id,trip_id,status,result,error")
    .eq("id", jobId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw unavailable();
  if (data === null) return null;
  const parsed = cloudJobSchema.safeParse(data);
  if (
    !parsed.success ||
    parsed.data.id !== jobId ||
    parsed.data.user_id !== userId
  )
    throw new Error("Не удалось проверить ответ облачной очереди.");
  return parsed.data;
}
export async function readCloudJobs(
  jobIds: string[],
  userId: string,
): Promise<CloudJob[]> {
  if (!jobIds.length) return [];
  if (
    jobIds.length > 100 ||
    !jobIds.every((id) => z.uuid().safeParse(id).success)
  )
    throw new Error("Не удалось проверить список заданий.");
  const sdk = await account(userId);
  const { data, error } = await sdk
    .from("recognition_jobs")
    .select("id,user_id,attempt_id,document_id,trip_id,status,result,error")
    .in("id", jobIds)
    .eq("user_id", userId)
    .limit(100);
  const parsed = z.array(cloudJobSchema).max(100).safeParse(data);
  if (
    error ||
    !parsed.success ||
    parsed.data.some(
      (job) => job.user_id !== userId || !jobIds.includes(job.id),
    )
  )
    throw unavailable();
  return parsed.data;
}
function binding(job: CloudJob, document: StoredDocument, attemptId: string) {
  if (
    job.document_id !== document.id ||
    job.trip_id !== document.tripId ||
    job.attempt_id !== attemptId
  )
    throw new Error("Задание относится к другой попытке распознавания.");
  return job;
}
export async function enqueueCloudDocument(
  document: StoredDocument,
  attemptId: string,
  jobId: string,
  userId: string,
): Promise<CloudJob> {
  const sdk = await account(userId);
  if (!document.fingerprint || !/^[a-f0-9]{64}$/.test(document.fingerprint))
    throw new Error("Не удалось проверить отпечаток документа.");
  const existing = await readCloudJob(jobId, userId);
  if (existing) return binding(existing, document, attemptId);
  const { error: uploadError } = await sdk.storage
    .from("vmeste-documents")
    .upload(`${userId}/${jobId}/document`, document.blob, {
      contentType: document.type,
      upsert: false,
    });
  if (
    uploadError &&
    String(uploadError.statusCode) !== "409" &&
    !(
      "code" in uploadError &&
      [
        "Duplicate",
        "ResourceAlreadyExists",
        "resource_already_exists",
      ].includes(String(uploadError.code))
    )
  ) {
    // Older Storage versions report duplicate uploads as an untyped HTTP 400.
    // Recover an uncertain upload only by verifying the immutable stored bytes.
    let recovered = false;
    try {
      const existingFile = await sdk.storage
        .from("vmeste-documents")
        .download(`${userId}/${jobId}/document`);
      recovered =
        !existingFile.error &&
        Boolean(existingFile.data) &&
        existingFile.data!.size === document.size &&
        (await fileFingerprint(existingFile.data!)) === document.fingerprint;
    } catch {
      /* Keep the document queued; no model job is created on doubt. */
    }
    if (!recovered)
      throw new Error(
        "Не удалось загрузить документ в закрытое хранилище. Файл сохранён на этом устройстве.",
      );
  }
  const { data, error } = await sdk.rpc("enqueue_recognition_job", {
    p_id: jobId,
    p_attempt_id: attemptId,
    p_document_id: document.id,
    p_trip_id: document.tripId,
    p_fingerprint: document.fingerprint,
    p_name: document.name,
    p_mime_type: document.type,
    p_size: document.size,
  });
  if (error) throw unavailable();
  const parsed = z.array(cloudJobSchema).length(1).safeParse(data);
  if (
    !parsed.success ||
    parsed.data[0].id !== jobId ||
    parsed.data[0].user_id !== userId
  )
    throw new Error(
      "Не удалось проверить созданное задание. Повторите отправку в очередь.",
    );
  return binding(parsed.data[0], document, attemptId);
}
