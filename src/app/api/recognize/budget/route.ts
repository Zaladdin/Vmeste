import { z } from "zod";
import {
  getRecognitionBudget,
  setRecognitionDailyLimit,
} from "../../../../lib/recognition-budget";
import { RecognitionError } from "../../../../lib/recognition-common";
import { effectiveLocalOrigin } from "../../../../lib/local-origin";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = {
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
};
const mutation = z.object({ limit: z.number().int().min(0).max(100) }).strict();
function forbidden() {
  return Response.json(
    { error: "Настройки доступны только в локальном приложении" },
    { status: 403, headers },
  );
}
function failure(error: unknown) {
  return Response.json(
    {
      error:
        error instanceof RecognitionError
          ? error.message
          : "Не удалось проверить дневной лимит. Распознавание остановлено.",
    },
    { status: error instanceof RecognitionError ? error.status : 503, headers },
  );
}
export async function GET(request: Request) {
  const origin = effectiveLocalOrigin(request);
  if (
    !origin ||
    (request.headers.has("origin") && request.headers.get("origin") !== origin)
  )
    return forbidden();
  try {
    return Response.json(await getRecognitionBudget(), { headers });
  } catch (error) {
    return failure(error);
  }
}
export async function PATCH(request: Request) {
  const origin = effectiveLocalOrigin(request);
  if (
    !origin ||
    request.headers.get("origin") !== origin ||
    request.headers.get("x-vmeste-recognition") !== "1"
  )
    return forbidden();
  try {
    if (
      request.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() !== "application/json" ||
      !request.body
    )
      throw new RecognitionError("Передайте дневной лимит в JSON", 400);
    const reader = request.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 512) {
          await reader.cancel();
          throw new RecognitionError("Слишком большой запрос настроек", 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const parsed = mutation.safeParse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    if (!parsed.success)
      throw new RecognitionError("Укажите целое число от 0 до 100", 400);
    return Response.json(await setRecognitionDailyLimit(parsed.data.limit), {
      headers,
    });
  } catch (error) {
    return failure(
      error instanceof SyntaxError
        ? new RecognitionError("Некорректный JSON", 400)
        : error,
    );
  }
}
