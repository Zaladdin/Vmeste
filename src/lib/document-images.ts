import { Worker } from "node:worker_threads";
import { writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { imageSize } from "image-size";
import { RecognitionError } from "./recognition-common";

const MAX_IMAGE_PIXELS = 24_000_000;
const PDF_WORKER_TIMEOUT_MS = 30_000;
const imageExtensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
const workerErrors: Record<string, string> = {
  page_limit:
    "В PDF больше 8 страниц. Разделите документ на несколько файлов и загрузите их отдельно.",
  password:
    "PDF защищён паролем. Загрузите копию без пароля или фотографии нужных страниц.",
  empty: "В PDF нет страниц для распознавания.",
  budget:
    "PDF слишком большой для распознавания. Разделите его на несколько файлов.",
  bad_pdf:
    "Не удалось прочитать PDF. Загрузите оригинал документа или изображения страниц.",
};

function cancelled() {
  return new RecognitionError("Подготовка документа отменена", 499);
}

/** Null means the entire PDF must be recognized visually, never partial text. */
export async function prepareDocumentText(
  file: File,
  workspace: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) throw cancelled();
  if (file.type !== "application/pdf") return null;
  if (!path.isAbsolute(workspace) || !(await stat(workspace)).isDirectory())
    throw new RecognitionError(
      "Не удалось подготовить временную папку документа",
      500,
    );
  if (file.size === 0 || file.size > 20 * 1024 * 1024)
    throw new RecognitionError(
      "Документ должен быть непустым и не больше 20 МБ",
      413,
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  return renderPdf(bytes, workspace, signal, true);
}

export async function prepareDocumentImages(
  file: File,
  workspace: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (signal?.aborted) throw cancelled();
  if (
    !path.isAbsolute(workspace) ||
    (await stat(workspace)).isDirectory() === false
  )
    throw new RecognitionError(
      "Не удалось подготовить временную папку документа",
      500,
    );
  if (file.size === 0 || file.size > 20 * 1024 * 1024)
    throw new RecognitionError(
      "Документ должен быть непустым и не больше 20 МБ",
      413,
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (signal?.aborted) throw cancelled();
  const extension = imageExtensions[file.type];
  if (extension) {
    try {
      const dimensions = imageSize(bytes);
      if (
        !Number.isFinite(dimensions.width) ||
        !Number.isFinite(dimensions.height) ||
        dimensions.width < 1 ||
        dimensions.height < 1 ||
        dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
      )
        throw new RecognitionError(
          "Слишком большое разрешение изображения. Уменьшите его до 24 мегапикселей.",
          422,
        );
      if (
        !({ png: "png", jpg: "jpg", webp: "webp" } as Record<string, string>)[
          dimensions.type ?? ""
        ] ||
        dimensions.type !== extension
      )
        throw new Error("Unsupported image encoding");
    } catch (error) {
      if (error instanceof RecognitionError) throw error;
      throw new RecognitionError(
        "Не удалось прочитать изображение. Загрузите оригинальный JPG, PNG или WebP.",
        422,
      );
    }
    const imagePath = path.join(workspace, `input.${extension}`);
    await writeFile(imagePath, bytes, { flag: "wx" });
    if (signal?.aborted) throw cancelled();
    return [imagePath];
  }
  if (file.type !== "application/pdf")
    throw new RecognitionError("Поддерживаются PDF, JPG, PNG и WebP", 415);
  return renderPdf(bytes, workspace, signal);
}

function renderPdf(
  bytes: Uint8Array,
  workspace: string,
  signal: AbortSignal | undefined,
  textOnly: true,
): Promise<string | null>;
function renderPdf(
  bytes: Uint8Array,
  workspace: string,
  signal?: AbortSignal,
): Promise<string[]>;
function renderPdf(
  bytes: Uint8Array,
  workspace: string,
  signal?: AbortSignal,
  textOnly = false,
): Promise<string[] | string | null> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    const worker = new Worker(
      path.join(process.cwd(), "src", "lib", "pdf-render-worker.mjs"),
      {
        workerData: { bytes, workspace, textOnly },
        transferList: [bytes.buffer as ArrayBuffer],
        resourceLimits: { maxOldGenerationSizeMb: 256 },
        execArgv: [],
        stdout: true,
        stderr: true,
      },
    );
    // PDF.js diagnostics may contain document text or local paths; never forward them.
    worker.stdout.resume();
    worker.stderr.resume();
    let finished = false;
    const finish = async (
      error?: RecognitionError,
      count?: number,
      text?: string | null,
    ) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await worker.terminate();
      if (error) {
        reject(error);
        return;
      }
      if (textOnly) {
        resolve(text ?? null);
        return;
      }
      resolve(
        Array.from({ length: count! }, (_, index) =>
          path.join(
            workspace,
            `page-${String(index + 1).padStart(2, "0")}.png`,
          ),
        ),
      );
    };
    const abort = () => {
      void finish(cancelled());
    };
    const timer = setTimeout(() => {
      void finish(
        new RecognitionError(
          "Подготовка PDF заняла слишком много времени. Попробуйте загрузить изображения нужных страниц.",
          504,
        ),
      );
    }, PDF_WORKER_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    worker.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null) {
        void finish(new RecognitionError(workerErrors.bad_pdf, 422));
        return;
      }
      const data = message as {
        ok?: unknown;
        count?: unknown;
        code?: unknown;
        text?: unknown;
      };
      if (
        data.ok === true &&
        typeof data.count === "number" &&
        Number.isInteger(data.count) &&
        data.count >= 1 &&
        data.count <= 8
      ) {
        if (
          textOnly &&
          !(
            data.text === null ||
            (typeof data.text === "string" && data.text.length <= 40_000)
          )
        ) {
          void finish(new RecognitionError(workerErrors.bad_pdf, 422));
          return;
        }
        void finish(
          undefined,
          data.count,
          data.text as string | null | undefined,
        );
        return;
      }
      const code = typeof data.code === "string" ? data.code : "bad_pdf";
      void finish(
        new RecognitionError(workerErrors[code] ?? workerErrors.bad_pdf, 422),
      );
    });
    worker.on("error", () => {
      void finish(new RecognitionError(workerErrors.bad_pdf, 422));
    });
    worker.on("exit", () => {
      if (!finished)
        void finish(new RecognitionError(workerErrors.bad_pdf, 422));
    });
    if (signal?.aborted) abort();
  });
}
