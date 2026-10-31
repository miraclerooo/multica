import { publishedMaterialPath as resolvePath } from "@multica/core/documents/links";

export const publishedMaterialPath = (value: string, apiOrigin: string) =>
  resolvePath(value, [apiOrigin]);
