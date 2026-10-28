export function effectiveLocalOrigin(request: Request): string | null {
  const url = new URL(request.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    return null;
  // Next can normalize request.url. Trust only a validated direct Host.
  const host = request.headers.get("host");
  if (host === null) return url.origin;
  const match =
    /^(?:127\.0\.0\.1|localhost|\[::1\])(?::([1-9]\d{0,4}))?$/i.exec(host);
  if (!match || (match[1] && Number(match[1]) > 65535)) return null;
  return new URL(`${url.protocol}//${host}`).origin;
}
