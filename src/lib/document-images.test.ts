import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { prepareDocumentImages, prepareDocumentText } from "./document-images";

const workspaces: string[] = [];
async function workspace() {
  const directory = await mkdtemp(path.join(tmpdir(), "vmeste-images-test-"));
  workspaces.push(directory);
  return directory;
}
function pdf(
  pages = 1,
  encrypted = false,
  oversizedImage = false,
  leadingRectangles = 1,
): Uint8Array<ArrayBuffer> {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, index) => `${3 + index * 2} 0 R`).join(" ")}] /Count ${pages} >>`,
  ];
  for (let index = 0; index < pages; index++) {
    const rectangles = leadingRectangles
      ? "0.2 0.4 0.3 rg " + "20 20 100 80 re f ".repeat(leadingRectangles)
      : "";
    const content =
      rectangles + (oversizedImage ? "q 100 0 0 100 0 0 cm /Im0 Do Q" : "");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << ${oversizedImage ? `/XObject << /Im0 ${3 + pages * 2} 0 R >>` : ""} >> /Contents ${4 + index * 2} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
  if (oversizedImage)
    objects.push(
      "<< /Type /XObject /Subtype /Image /Width 30000 /Height 30000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 1 >>\nstream\n\x00\nendstream",
    );
  if (encrypted)
    objects.push(
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`,
    );
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<${"01".repeat(16)}><${"01".repeat(16)}>]` : ""} >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(output));
}
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/p0AAAAASUVORK5CYII=",
  "base64",
);

function textPdf(text: string, image = false, blankSecondPage = false) {
  const content =
    (text.match(/.{1,40}/g) ?? [])
      .map((chunk) => `BT /F1 12 Tf 20 350 Td (${chunk}) Tj ET`)
      .join("\n") + (image ? " q 1 0 0 1 0 0 cm /Im0 Do Q" : "");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [3 0 R${blankSecondPage ? " 7 0 R" : ""}] /Count ${blankSecondPage ? 2 : 1} >>`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> /XObject << /Im0 6 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nA\nendstream",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> /Contents 8 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(output));
}

describe("document image preparation", () => {
  it("extracts all flight text and line boundaries without writing images", async () => {
    const directory = await workspace();
    const bytes = new Uint8Array(
      await readFile(path.join(process.cwd(), "examples", "test-ticket.pdf")),
    );
    const text = await prepareDocumentText(
      new File([bytes], "ticket.pdf", { type: "application/pdf" }),
      directory,
    );
    expect(text).toContain("J2 077");
    expect(text).toContain("TK 1827");
    expect(text).toContain("09:30");
    expect(text).toContain("16:30");
    expect(text).toContain("\n");
    expect(await readdir(directory)).toEqual([]);
  }, 20000);
  it("requests image fallback for a scanned/blank page or mixed text/image PDF", async () => {
    const content =
      "Confirmed flight departure Baku GYD 11 May 2027 09:30 arrival Istanbul IST 11:40";
    for (const bytes of [
      pdf(1),
      textPdf(content, true),
      textPdf(content, false, true),
    ]) {
      expect(
        await prepareDocumentText(
          new File([bytes], "mixed.pdf", { type: "application/pdf" }),
          await workspace(),
        ),
      ).toBeNull();
    }
  }, 20000);
  it("does not send partial or oversized extracted text", async () => {
    expect(
      await prepareDocumentText(
        new File([textPdf("Booking confirmation ".repeat(2500))], "large.pdf", {
          type: "application/pdf",
        }),
        await workspace(),
      ),
    ).toBeNull();
    await expect(
      prepareDocumentText(
        new File([pdf(1, false, true, 5000)], "partial.pdf", {
          type: "application/pdf",
        }),
        await workspace(),
      ),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      prepareDocumentText(
        new File(["%PDF-broken secret"], "broken.pdf", {
          type: "application/pdf",
        }),
        await workspace(),
      ),
    ).rejects.toMatchObject({ status: 422 });
  }, 20000);
  it("keeps PDF protection and page limits in text mode", async () => {
    for (const bytes of [pdf(1, true), pdf(9), pdf(0)]) {
      await expect(
        prepareDocumentText(
          new File([bytes], "restricted.pdf", { type: "application/pdf" }),
          await workspace(),
        ),
      ).rejects.toMatchObject({ status: 422 });
    }
  }, 20000);
  it("skips text extraction for images and respects cancellation", async () => {
    expect(
      await prepareDocumentText(
        new File([png], "image.png", { type: "image/png" }),
        await workspace(),
      ),
    ).toBeNull();
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareDocumentText(
        new File([pdf()], "cancelled.pdf", { type: "application/pdf" }),
        await workspace(),
        controller.signal,
      ),
    ).rejects.toMatchObject({ status: 499 });
  });
  afterEach(async () => {
    for (const directory of workspaces.splice(0)) {
      const resolved = path.resolve(directory);
      if (
        path.dirname(resolved) !== path.resolve(tmpdir()) ||
        !path.basename(resolved).startsWith("vmeste-images-test-")
      )
        throw new Error("Unexpected cleanup target");
      await rm(resolved, { recursive: true, force: true });
    }
  });
  it("stores an image under a fixed safe filename without changing its content", async () => {
    const directory = await workspace();
    const result = await prepareDocumentImages(
      new File([png], "../../attack.png", { type: "image/png" }),
      directory,
    );
    expect(result).toEqual([path.join(directory, "input.png")]);
    expect(await readFile(result[0])).toEqual(png);
  });
  it("accepts actual JPEG and WebP images with fixed matching extensions", async () => {
    const canvas = createCanvas(10, 10);
    const context = canvas.getContext("2d");
    context.fillStyle = "#284e3f";
    context.fillRect(0, 0, 10, 10);
    for (const [mime, extension] of [
      ["image/jpeg", "jpg"],
      ["image/webp", "webp"],
    ] as const) {
      const bytes = new Uint8Array(canvas.toBuffer(mime));
      const directory = await workspace();
      expect(
        await prepareDocumentImages(
          new File([bytes], "file.bin", { type: mime }),
          directory,
        ),
      ).toEqual([path.join(directory, `input.${extension}`)]);
    }
    canvas.width = 1;
    canvas.height = 1;
  });
  it("renders every PDF page to a bounded PNG using the actual worker", async () => {
    const directory = await workspace();
    const result = await prepareDocumentImages(
      new File([pdf(2)], "ticket.pdf", { type: "application/pdf" }),
      directory,
    );
    expect(result).toHaveLength(2);
    for (const file of result) {
      const bytes = await readFile(file);
      expect([...bytes.subarray(0, 8)]).toEqual([
        137, 80, 78, 71, 13, 10, 26, 10,
      ]);
      expect(bytes.readUInt32BE(16)).toBeLessThanOrEqual(1800);
      expect(bytes.readUInt32BE(20)).toBeLessThanOrEqual(1800);
      expect((await stat(file)).size).toBeGreaterThan(100);
      const image = await loadImage(bytes);
      const canvas = createCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const pixel = context.getImageData(100, image.height - 100, 1, 1).data;
      expect(pixel[1]).toBeGreaterThan(pixel[0]);
      canvas.width = 1;
      canvas.height = 1;
    }
  }, 20000);
  it("renders the Chrome-generated synthetic flight ticket with embedded fonts", async () => {
    const bytes = new Uint8Array(
      await readFile(path.join(process.cwd(), "examples", "test-ticket.pdf")),
    );
    const result = await prepareDocumentImages(
      new File([bytes], "ticket.pdf", { type: "application/pdf" }),
      await workspace(),
    );
    expect(result).toHaveLength(1);
    const image = await readFile(result[0]);
    expect(image.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(image.byteLength).toBeGreaterThan(10000);
  }, 20000);
  it("accepts a valid blank page without inferring a parsing failure from its operators", async () => {
    await expect(
      prepareDocumentImages(
        new File([pdf(1, false, false, 0)], "blank.pdf", {
          type: "application/pdf",
        }),
        await workspace(),
      ),
    ).resolves.toHaveLength(1);
  }, 20000);
  it("rejects more than eight pages instead of silently truncating", async () => {
    await expect(
      prepareDocumentImages(
        new File([pdf(9)], "many.pdf", { type: "application/pdf" }),
        await workspace(),
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/8 страниц/),
    });
  }, 20000);
  it("rejects password-protected PDFs with a useful message", async () => {
    await expect(
      prepareDocumentImages(
        new File([pdf(1, true)], "locked.pdf", { type: "application/pdf" }),
        await workspace(),
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/парол/),
    });
  }, 20000);
  it("rejects malformed and empty PDFs without leaking parser details", async () => {
    await expect(
      prepareDocumentImages(
        new File(["%PDF-broken secret-test"], "broken.pdf", {
          type: "application/pdf",
        }),
        await workspace(),
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.not.stringContaining("secret-test"),
    });
    await expect(
      prepareDocumentImages(
        new File([pdf(0)], "empty.pdf", { type: "application/pdf" }),
        await workspace(),
      ),
    ).rejects.toMatchObject({ status: 422 });
  }, 20000);
  it("rejects oversized image dimensions before decoding", async () => {
    const giant = Buffer.from(png);
    giant.writeUInt32BE(30000, 16);
    giant.writeUInt32BE(30000, 20);
    await expect(
      prepareDocumentImages(
        new File([giant], "giant.png", { type: "image/png" }),
        await workspace(),
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/разрешени/),
    });
  });
  it("rejects oversized embedded PDF images instead of rendering a partial document", async () => {
    await expect(
      prepareDocumentImages(
        new File([pdf(1, false, true)], "large-image.pdf", {
          type: "application/pdf",
        }),
        await workspace(),
      ),
    ).rejects.toMatchObject({ status: 422 });
  }, 20000);
  it("rejects PDF stream failures after earlier operator chunks were flushed", async () => {
    await expect(
      prepareDocumentImages(
        new File([pdf(1, false, true, 5000)], "partial.pdf", {
          type: "application/pdf",
        }),
        await workspace(),
      ),
    ).rejects.toMatchObject({ status: 422 });
  }, 20000);
  it("rejects invalid image data and unsupported formats", async () => {
    await expect(
      prepareDocumentImages(
        new File(["image"], "bad.png", { type: "image/png" }),
        await workspace(),
      ),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      prepareDocumentImages(
        new File(["text"], "bad.txt", { type: "text/plain" }),
        await workspace(),
      ),
    ).rejects.toMatchObject({ status: 415 });
  });
  it("cancels before work or while the worker is running", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareDocumentImages(
        new File([png], "ticket.png", { type: "image/png" }),
        await workspace(),
        controller.signal,
      ),
    ).rejects.toMatchObject({ status: 499 });
    const running = new AbortController();
    const preparing = prepareDocumentImages(
      new File([pdf(8)], "ticket.pdf", { type: "application/pdf" }),
      await workspace(),
      running.signal,
    );
    setTimeout(() => running.abort(), 5);
    await expect(preparing).rejects.toMatchObject({ status: 499 });
  }, 20000);
});
