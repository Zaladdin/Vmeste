import {
  recognizeDocument,
  RecognitionError,
  getRecognitionProvider,
} from "../../../lib/recognition-server";
import { effectiveLocalOrigin } from "../../../lib/local-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;
const MAX_BODY_BYTES = 21 * 1024 * 1024;
const headers = {
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
};

async function readForm(request: Request): Promise<FormData> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES))
    throw new RecognitionError("Документ должен быть не больше 20 МБ", 413);
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;"))
    throw new RecognitionError("Загрузите документ через форму", 400);
  if (!request.body) throw new RecognitionError("Документ не получен", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RecognitionError("Документ должен быть не больше 20 МБ", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return await new Response(buffer, {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw new RecognitionError(
      "Не удалось прочитать загруженный документ",
      400,
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  const origin = effectiveLocalOrigin(request);
  if (
    !origin ||
    (request.headers.has("origin") && request.headers.get("origin") !== origin)
  )
    return Response.json(
      { error: "Распознавание доступно только в локальном приложении" },
      { status: 403, headers },
    );
  try {
    const provider = getRecognitionProvider();
    return Response.json(
      {
        provider,
        configured: provider === "codex" || Boolean(process.env.OPENAI_API_KEY),
      },
      { headers },
    );
  } catch {
    return Response.json(
      { error: "Проверьте способ распознавания в настройках сервера" },
      { status: 503, headers },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const origin = effectiveLocalOrigin(request);
  if (
    !origin ||
    request.headers.get("origin") !== origin ||
    request.headers.get("x-vmeste-recognition") !== "1"
  )
    return Response.json(
      {
        error: "Запрос распознавания разрешён только из локального приложения",
      },
      { status: 403, headers },
    );
  try {
    const form = await readForm(request);
    const file = form.get("file");
    if (!(file instanceof File))
      throw new RecognitionError("Выберите файл билета или брони", 400);
    const result = await recognizeDocument(file, request.signal);
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof RecognitionError)
      return Response.json(
        { error: error.message },
        {
          status: error.status,
          headers: {
            ...headers,
            ...(error.retryAfter
              ? { "Retry-After": String(error.retryAfter) }
              : {}),
          },
        },
      );
    return Response.json(
      {
        error:
          "Не удалось обработать документ. Сохранённый файл можно скачать или распознать повторно.",
      },
      { status: 500, headers },
    );
  }
}
