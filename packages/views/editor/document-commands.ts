import type { Editor } from "@tiptap/core";

export type DocumentCommand =
  | "h2"
  | "h3"
  | "bold"
  | "italic"
  | "inline_code"
  | "bullet"
  | "task"
  | "quote"
  | "table"
  | "code"
  | "mermaid";
export function runDocumentCommand(editor: Editor, command: DocumentCommand) {
  const chain = editor.chain().focus();
  switch (command) {
    case "h2":
      return chain.toggleHeading({ level: 2 }).run();
    case "h3":
      return chain.toggleHeading({ level: 3 }).run();
    case "bold":
      return chain.toggleBold().run();
    case "italic":
      return chain.toggleItalic().run();
    case "inline_code":
      return chain.toggleCode().run();
    case "bullet":
      return chain.toggleBulletList().run();
    case "task":
      return chain.toggleTaskList().run();
    case "quote":
      return chain.toggleBlockquote().run();
    case "table":
      return chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    case "code":
      return chain.toggleCodeBlock().run();
    case "mermaid":
      return chain.setCodeBlock({ language: "mermaid" }).run();
  }
}
