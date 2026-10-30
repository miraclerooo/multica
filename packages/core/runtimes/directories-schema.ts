import { z } from "zod";

export const DirectoryBrowseResultSchema = z.object({
  path: z.string().default(""),
  real_path: z.string().default(""),
  parent: z.string().default(""),
  entries: z
    .array(z.object({ name: z.string(), path: z.string() }))
    .default([]),
  truncated: z.boolean().default(false),
  is_git_repo: z.boolean().default(false),
});

export const DirectoryBrowseRequestSchema = z.object({
  id: z.string(),
  runtime_id: z.string(),
  daemon_id: z.string(),
  status: z
    .enum(["pending", "running", "completed", "failed", "timeout"])
    .catch("failed"),
  result: DirectoryBrowseResultSchema.optional(),
  error: z.string().default(""),
});

export type DirectoryBrowseInput = {
  operation: "roots" | "list" | "validate";
  path?: string;
};
export type DirectoryBrowseResult = z.infer<typeof DirectoryBrowseResultSchema>;
export type DirectoryBrowseRequest = z.infer<
  typeof DirectoryBrowseRequestSchema
>;
export const MALFORMED_DIRECTORY_REQUEST: DirectoryBrowseRequest = {
  id: "",
  runtime_id: "",
  daemon_id: "",
  status: "failed",
  error: "Invalid directory response",
};
