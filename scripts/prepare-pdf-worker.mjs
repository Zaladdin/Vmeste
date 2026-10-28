import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distribution = path.join(root, "node_modules/pdfjs-dist");
const { version } = JSON.parse(
  await readFile(path.join(distribution, "package.json"), "utf8"),
);
if (version !== "6.4.299")
  throw new Error(
    "Update the browser PDF worker URL together with pdfjs-dist.",
  );
await copyFile(
  path.join(distribution, "legacy/build/pdf.worker.min.mjs"),
  path.join(root, "public/pdf.worker-6.4.299.min.mjs"),
);
