import { parentPort, workerData } from "node:worker_threads";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_PAGES = 8;
const MAX_PIXELS = 26_000_000;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_CHARS = 40_000;
const imageOperators = new Set(
  Object.entries(OPS)
    .filter(([name]) => /image/i.test(name))
    .map(([, value]) => value),
);
let task;
let document;
let output;
try {
  const distribution = path.dirname(
    createRequire(path.join(process.cwd(), "package.json")).resolve(
      "pdfjs-dist/package.json",
    ),
  );
  task = getDocument({
    data: workerData.bytes,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    stopAtErrors: true,
    maxImageSize: 24_000_000,
    enableXfa: false,
    verbosity: 0,
    standardFontDataUrl:
      path.join(distribution, "standard_fonts").replaceAll("\\", "/") + "/",
    cMapUrl: path.join(distribution, "cmaps").replaceAll("\\", "/") + "/",
    cMapPacked: true,
    wasmUrl: path.join(distribution, "wasm").replaceAll("\\", "/") + "/",
  });
  document = await task.promise;
  // PDF.js 6.4.299 _pumpOperatorList resolves getOperatorList on a stream
  // failure before rejecting it, so a flushed partial list can look complete.
  // Observe the original stream failure before PDF.js consumes it. Fail closed
  // if this pinned internal interface changes on a future dependency upgrade.
  const handler = document._transport?.messageHandler;
  if (typeof handler?.sendWithStream !== "function") throw { code: "bad_pdf" };
  const sendWithStream = handler.sendWithStream;
  let operatorStreamFailed = false;
  handler.sendWithStream = function (action, ...args) {
    const stream = sendWithStream.call(this, action, ...args);
    if (action !== "GetOperatorList") return stream;
    const reader = stream.getReader();
    return new ReadableStream({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            reader.releaseLock();
            controller.close();
          } else {
            controller.enqueue(result.value);
          }
        } catch (error) {
          operatorStreamFailed = true;
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    });
  };
  if (document.numPages < 1) throw { code: "empty" };
  if (document.numPages > MAX_PAGES) throw { code: "page_limit" };
  let pixels = 0,
    totalBytes = 0;
  let textUsable = true;
  const textPages = [];
  let textLength = 0;
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number);
    // Reject parsing failures before rendering; render() may recover a partial page.
    const operators = await page.getOperatorList({
      intent: "display",
      annotationMode: 0,
    });
    if (operatorStreamFailed) throw { code: "bad_pdf" };
    if (workerData.textOnly) {
      // An image may contain another reservation or details absent from the
      // text layer. Fall back for the whole file, even if other pages have text.
      if (operators.fnArray.some((operator) => imageOperators.has(operator)))
        textUsable = false;
      if (textUsable) {
        const content = await page.getTextContent();
        let text = "";
        let previousY;
        for (const item of content.items) {
          if (typeof item.str !== "string") continue;
          const y = item.transform?.[5];
          if (
            text &&
            previousY !== undefined &&
            y !== undefined &&
            Math.abs(y - previousY) > 2 &&
            !text.endsWith("\n")
          )
            text += "\n";
          text += item.str + (item.hasEOL ? "\n" : " ");
          previousY = y;
          if (text.length + textLength > MAX_TEXT_CHARS) {
            textUsable = false;
            break;
          }
        }
        text = text.trim();
        if (
          (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 40 ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/u.test(text)
        )
          textUsable = false;
        textLength += text.length + 20;
        if (textLength > MAX_TEXT_CHARS) textUsable = false;
        if (textUsable) textPages.push(`--- Page ${number} ---\n${text}`);
      }
      page.cleanup();
      continue;
    }
    const original = page.getViewport({ scale: 1 });
    if (
      !Number.isFinite(original.width) ||
      !Number.isFinite(original.height) ||
      original.width <= 0 ||
      original.height <= 0
    )
      throw { code: "bad_pdf" };
    const scale = Math.min(2, 1800 / Math.max(original.width, original.height));
    const viewport = page.getViewport({ scale });
    const width = Math.ceil(viewport.width),
      height = Math.ceil(viewport.height);
    if (width < 1 || height < 1 || width > 1800 || height > 1800)
      throw { code: "budget" };
    pixels += width * height;
    if (pixels > MAX_PIXELS) throw { code: "budget" };
    const canvas = createCanvas(width, height);
    try {
      const context = canvas.getContext("2d");
      await page.render({
        canvas,
        canvasContext: context,
        viewport,
        annotationMode: 0,
        background: "rgb(255,255,255)",
      }).promise;
      if (operatorStreamFailed) throw { code: "bad_pdf" };
      const bytes = canvas.toBuffer("image/png");
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_OUTPUT_BYTES) throw { code: "budget" };
      await writeFile(
        path.join(
          workerData.workspace,
          `page-${String(number).padStart(2, "0")}.png`,
        ),
        bytes,
        { flag: "wx" },
      );
    } finally {
      canvas.width = 1;
      canvas.height = 1;
      page.cleanup();
    }
  }
  output = {
    ok: true,
    count: document.numPages,
    ...(workerData.textOnly
      ? { text: textUsable ? textPages.join("\n\n") : null }
      : {}),
  };
} catch (error) {
  output = {
    ok: false,
    code:
      error?.name === "PasswordException"
        ? "password"
        : ["page_limit", "empty", "budget"].includes(error?.code)
          ? error.code
          : "bad_pdf",
  };
} finally {
  try {
    if (task) await task.destroy();
  } catch {
    /* Parent destroys the isolated worker after receiving the sanitized result. */
  }
}
parentPort.postMessage(output);
