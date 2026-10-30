export interface DocumentOutlineItem {
  id: string;
  title: string;
  line: number;
}
export interface DocumentTask {
  line: number;
  text: string;
  checked: boolean;
}

export function documentStructure(body: string) {
  const requirements: DocumentOutlineItem[] = [];
  const tasks: DocumentTask[] = [];
  let scenarios = 0;
  let fence: string | undefined;
  body.split("\n").forEach((line, index) => {
    const delimiter = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (delimiter?.[1]) {
      if (!fence) fence = delimiter[1];
      else if (
        delimiter[1][0] === fence[0] &&
        delimiter[1].length >= fence.length
      )
        fence = undefined;
      return;
    }
    if (fence) return;
    const heading = line.match(/^#{1,6}\s+.*?\b(REQ-[\w-]+)\b[:：]?\s*(.*)/i);
    if (heading)
      requirements.push({
        id: heading[1]!,
        title: heading[2] || heading[1]!,
        line: index,
      });
    if (
      /^#{1,6}\s+(?:Scenario|场景|場景|シナリオ|시나리오|Scénario)\s*[:：]/i.test(
        line,
      )
    )
      scenarios++;
    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (task)
      tasks.push({
        line: index,
        checked: task[1]?.toLowerCase() === "x",
        text: task[2]!,
      });
  });
  return { requirements, scenarios, tasks };
}

export function insertDocumentBlock(
  body: string,
  kind: "requirement" | "scenario" | "task",
): string {
  const structure = documentStructure(body);
  const used = new Set(
    structure.requirements.map((item) => item.id.toUpperCase()),
  );
  let n = 1;
  while (used.has(`REQ-${String(n).padStart(2, "0")}`)) n++;
  const block =
    kind === "requirement"
      ? `### REQ-${String(n).padStart(2, "0")}: New requirement\n\nDescribe the expected behavior.`
      : kind === "scenario"
        ? "### Scenario: New scenario\n\n**WHEN** an action occurs\n\n**THEN** the expected result follows."
        : "- [ ] New acceptance criterion";
  return `${body.trimEnd()}\n\n${block}\n`;
}
