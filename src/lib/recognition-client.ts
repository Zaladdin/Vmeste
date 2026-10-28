import {
  recognitionResponseSchema,
  type RecognitionResult,
} from "./recognition";
import type { StoredDocument } from "./model";
import { RECOGNITION_TIMEOUT_MS } from "./recognition-common";

export async function fileFingerprint(blob: Blob): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function recognizeFile(
  document: StoredDocument,
): Promise<RecognitionResult> {
  const form = new FormData();
  form.append("file", document.blob, document.name);
  let response: Response;
  try {
    response = await fetch("/api/recognize", {
      method: "POST",
      headers: { "x-vmeste-recognition": "1" },
      body: form,
      signal: AbortSignal.timeout(RECOGNITION_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    )
      throw new Error(
        "Распознавание заняло слишком много времени. Файл сохранён — попробуйте ещё раз.",
      );
    throw new Error(
      "Для распознавания нужен доступ к серверу и интернет. Файл сохранён, можно повторить позже.",
    );
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("Сервер вернул непонятный ответ. Документ сохранён.");
  }
  if (!response.ok) {
    const message =
      typeof data === "object" &&
      data !== null &&
      "error" in data &&
      typeof data.error === "string"
        ? data.error.slice(0, 500)
        : "Не удалось распознать документ. Попробуйте позже.";
    throw new Error(message);
  }
  const result = recognitionResponseSchema.safeParse(data);
  if (!result.success)
    throw new Error(
      "Не удалось проверить результат распознавания. Документ сохранён.",
    );
  return result.data;
}
