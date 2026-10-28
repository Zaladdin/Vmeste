export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";
export const STATIC_HOSTING = process.env.NEXT_PUBLIC_STATIC_EXPORT === "true";

/** Paths supplied here are application-owned absolute paths, never user URLs. */
export function publicPath(path: `/${string}`): string {
  return `${BASE_PATH}${path}`;
}
