// @vitest-environment node
import { describe, expect, it } from "vitest";
import { documentStructure, insertDocumentBlock } from "./markdown";

describe("document Markdown structure", () => {
  it("derives requirement anchors, scenario counts and tasks from actual Markdown, ignoring fences", () => {
    const body =
      "## Requirements\n### REQ-DOC-01: Keep drafts\n### Scenario: Failure\n- [ ] Preserve title\n- [X] Preserve body\n```md\n### REQ-FAKE: Example\n- [ ] Fake\n```\n";
    const structure = documentStructure(body);
    expect(structure.requirements).toEqual([
      { id: "REQ-DOC-01", title: "Keep drafts", line: 1 },
    ]);
    expect(structure.scenarios).toBe(1);
    expect(structure.tasks).toEqual([
      { line: 3, text: "Preserve title", checked: false },
      { line: 4, text: "Preserve body", checked: true },
    ]);
  });
  it("inserts a unique REQ and keeps all existing content when adding scenarios and acceptance items", () => {
    const body = "### REQ-01: First\n### REQ-03: Third\n\nUnchanged content";
    const next = insertDocumentBlock(body, "requirement");
    expect(next.startsWith(body)).toBe(true);
    expect(documentStructure(next).requirements.map((r) => r.id)).toEqual([
      "REQ-01",
      "REQ-03",
      "REQ-02",
    ]);
    const withScenario = insertDocumentBlock(next, "scenario");
    expect(withScenario).toContain("**WHEN**");
    expect(withScenario).toContain("**THEN**");
    expect(
      documentStructure(insertDocumentBlock(withScenario, "task")).tasks,
    ).toHaveLength(1);
  });
});
