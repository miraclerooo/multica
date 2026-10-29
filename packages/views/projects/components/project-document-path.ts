export interface ProjectDocsHandle {
  flush: () => Promise<boolean>;
}

export function projectDocumentPath(
  pathname: string,
  search: URLSearchParams,
  id?: string,
  edit = false,
) {
  const params = new URLSearchParams(search);
  params.set("tab", "docs");
  if (id) params.set("doc", id);
  else params.delete("doc");
  if (edit) params.set("mode", "edit");
  else params.delete("mode");
  return `${pathname}?${params}`;
}
