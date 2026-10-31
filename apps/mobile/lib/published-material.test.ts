import { expect, it } from "vitest";
import { publishedMaterialPath } from "./published-material";
it("keeps fixed internal material paths on the authenticated mobile transport", () => {
  const path =
    "/api/projects/01a191db-0b9e-7c1f-a9c0-d4c97ce9b2c5/documents/01a191db-0931-7ae2-85fa-245c0bfc694a/revisions/3/content?workspace_id=w";
  expect(publishedMaterialPath(path, "https://api.example.test")).toBe(path);
  expect(
    publishedMaterialPath(
      `https://api.example.test${path}`,
      "https://api.example.test",
    ),
  ).toBe(path);
  expect(
    publishedMaterialPath(
      "/api/pipeline-runs/01a191db-0b9e-7c1f-a9c0-d4c97ce9b2c5/artifact-content?artifact_id=a",
      "https://api.example.test",
    ),
  ).toContain("artifact_id=a");
});
it("does not attach credentials to external links or arbitrary API routes", () => {
  expect(
    publishedMaterialPath(
      "https://other.test/api/attachments/01a191db-0931-7ae2-85fa-245c0bfc694a/download",
      "https://api.example.test",
    ),
  ).toBeNull();
  expect(
    publishedMaterialPath("/api/me", "https://api.example.test"),
  ).toBeNull();
  expect(
    publishedMaterialPath(
      "file:///runtime/report.md",
      "https://api.example.test",
    ),
  ).toBeNull();
  expect(
    publishedMaterialPath("javascript:alert(1)", "https://api.example.test"),
  ).toBeNull();
});
