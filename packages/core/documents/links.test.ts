// @vitest-environment node
import { expect, it } from "vitest";
import { publishedMaterialContentType, publishedMaterialPath } from "./links";
it("resolves only fixed internal resources from this deployment", () => {
  const path =
    "/api/projects/01a191db-0b9e-7c1f-a9c0-d4c97ce9b2c5/documents/01a191db-0931-7ae2-85fa-245c0bfc694a/revisions/3/content";
  expect(publishedMaterialPath(path, ["https://api.example.test"])).toBe(path);
  expect(
    publishedMaterialPath(`https://foreign.test${path}`, [
      "https://api.example.test",
    ]),
  ).toBeNull();
  expect(
    publishedMaterialPath("/api/attachments/not-a-uuid/download", [
      "https://api.example.test",
    ]),
  ).toBeNull();
  expect(
    publishedMaterialPath("https://user:pass@api.example.test" + path, [
      "https://api.example.test",
    ]),
  ).toBeNull();
});
it("renders octet-stream repository materials by their fixed path without overriding explicit server types", () => {
  expect(
    publishedMaterialContentType(
      "application/octet-stream",
      "reports/evidence.md",
    ),
  ).toBe("text/markdown");
  expect(
    publishedMaterialContentType(
      "application/octet-stream",
      "design/Prototype.HTML",
    ),
  ).toBe("text/html");
  expect(
    publishedMaterialContentType("application/octet-stream", "artifact.pdf"),
  ).toBe("application/pdf");
  expect(publishedMaterialContentType("text/plain", "prototype.html")).toBe(
    "text/plain",
  );
  expect(
    publishedMaterialContentType("application/octet-stream", "bundle.zip"),
  ).toBe("application/octet-stream");
});
