import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type {
  DirectoryBrowseInput,
  DirectoryBrowseResult,
} from "./directories-schema";

function waitForPoll(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Directory request cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, 500);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function resolveDirectoryBrowse(
  runtimeId: string,
  input: DirectoryBrowseInput,
  signal?: AbortSignal,
): Promise<DirectoryBrowseResult> {
  let request = await api.initiateDirectoryBrowse(runtimeId, input, signal);
  const startedAt = Date.now();
  while (request.status === "pending" || request.status === "running") {
    if (Date.now() - startedAt >= 65_000)
      throw new Error("Directory request timed out");
    await waitForPoll(signal);
    request = await api.getDirectoryBrowse(runtimeId, request.id, signal);
  }
  if (request.status !== "completed" || !request.result) {
    throw new Error(
      request.error || "Could not read the selected machine's directory",
    );
  }
  return request.result;
}

export function directoryBrowseOptions(
  wsId: string,
  runtimeId: string | undefined,
  path: string,
) {
  return queryOptions({
    queryKey: ["runtimes", wsId, runtimeId, "directories", path],
    queryFn: ({ signal }) =>
      resolveDirectoryBrowse(
        runtimeId!,
        path ? { operation: "list", path } : { operation: "roots" },
        signal,
      ),
    enabled: Boolean(runtimeId),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}

export function isAbsoluteDirectoryPath(value: string): boolean {
  const path = value.trim();
  return (
    path.startsWith("/") ||
    path.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(path)
  );
}
