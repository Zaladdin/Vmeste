import { publicPath } from "./deployment";
import { extractPeopleFromPdfText } from "./pdf-people";

/** Read-only candidate discovery; never uploads the original or invokes a model. */
export async function discoverPdfPeople(
  blob: Blob,
  signal: AbortSignal,
): Promise<string[]> {
  if (blob.size > 20 * 1024 * 1024 || blob.size === 0)
    throw new Error("PDF должен быть не больше 20 МБ.");
  if (signal.aborted) throw new Error("Проверка остановлена.");
  const { getDocument, GlobalWorkerOptions } =
    await import("pdfjs-dist/legacy/build/pdf.mjs");
  GlobalWorkerOptions.workerSrc = publicPath("/pdf.worker-6.4.299.min.mjs");
  const task = getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    stopAtErrors: true,
    enableXfa: false,
    verbosity: 0,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("Проверка остановлена."));
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => reject(new Error("Не удалось быстро прочитать PDF.")),
        15_000,
      );
      if (signal.aborted) abort();
    });
    const reading = (async () => {
      const pdf = await task.promise;
      if (pdf.numPages > 8)
        throw new Error("Для проверки доступны PDF до 8 страниц.");
      let text = "";
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        let lastY: number | undefined;
        for (const item of content.items) {
          if (!("str" in item)) continue;
          const y = item.transform[5];
          if (lastY !== undefined && Math.abs(y - lastY) > 2) text += "\n";
          text += item.str + (item.hasEOL ? "\n" : " ");
          lastY = y;
          if (text.length > 40_000)
            throw new Error("В PDF слишком много текста для этой проверки.");
        }
        text += "\n";
        page.cleanup();
      }
      return extractPeopleFromPdfText(text);
    })();
    return await Promise.race([reading, deadline]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    await task.destroy();
  }
}
