import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    maxWorkers: 4,
    coverage: {
      provider: "v8",
      include: [
        "src/lib/model.ts",
        "src/lib/storage.ts",
        "src/lib/recognition.ts",
        "src/lib/recognition-client.ts",
        "src/lib/recognition-server.ts",
        "src/lib/codex-recognition.ts",
        "src/lib/codex-document.ts",
        "src/lib/document-images.ts",
        "src/lib/recognition-common.ts",
        "src/lib/recognition-budget.ts",
        "src/lib/local-origin.ts",
        "src/app/api/recognize/budget/route.ts",
        "src/app/api/recognize/route.ts",
      ],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
