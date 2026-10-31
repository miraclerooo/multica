/** Recognize fixed internal content without sending session credentials elsewhere. */
export function publishedMaterialPath(
  value: string,
  origins: string[],
): string | null {
  if (value.startsWith("//")) return null;
  const fallback =
    origins.find((origin) => /^https?:\/\//.test(origin)) ??
    "https://multica.invalid";
  try {
    const url = new URL(value, fallback);
    if (url.username || url.password || !/^https?:$/.test(url.protocol))
      return null;
    const relative = value.startsWith("/");
    if (
      !relative &&
      !origins.some((origin) => {
        try {
          return new URL(origin).origin === url.origin;
        } catch {
          return false;
        }
      })
    )
      return null;
    const id = "[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}";
    const allowed = new RegExp(
      `^/api/(?:projects/${id}/documents/${id}/revisions/[1-9][0-9]*/content|attachments/${id}/(?:download|content)|pipeline-runs/${id}/artifact-content)$`,
      "i",
    );
    return allowed.test(url.pathname) ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

/** Repository artifacts are intentionally served as octet-stream by the API. */
export function publishedMaterialContentType(
  contentType: string,
  filename: string,
): string {
  if (contentType && !contentType.startsWith("application/octet-stream"))
    return contentType;
  const extension = filename.split(".").at(-1)?.toLowerCase();
  const types: Record<string, string> = {
    md: "text/markdown",
    markdown: "text/markdown",
    txt: "text/plain",
    yaml: "text/plain",
    yml: "text/plain",
    json: "application/json",
    log: "text/plain",
    html: "text/html",
    htm: "text/html",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
  };
  return types[extension ?? ""] ?? (contentType || "application/octet-stream");
}
