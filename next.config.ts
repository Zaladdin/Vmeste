import type { NextConfig } from "next";
const config: NextConfig = {
  ...(process.env.NEXT_PUBLIC_STATIC_EXPORT === "true"
    ? ({
        output: "export",
        basePath: process.env.NEXT_PUBLIC_BASE_PATH || "/Vmeste",
        trailingSlash: true,
        images: { unoptimized: true },
      } as const)
    : {}),
  devIndicators: false,
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas"],
  outputFileTracingIncludes: {
    "/api/recognize": ["./src/lib/pdf-render-worker.mjs"],
  },
};
export default config;
