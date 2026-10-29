"use client";

import { useEditorState, type Editor } from "@tiptap/react";
import {
  Bold,
  Italic,
  Code,
  Heading2,
  Heading3,
  List,
  ListTodo,
  Quote,
  Table2,
  type IconComponent,
} from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import { TooltipHint } from "@multica/ui/components/common/tooltip-hint";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@multica/ui/components/ui/dropdown-menu";
import { useT } from "../i18n";
import { runDocumentCommand, type DocumentCommand } from "./document-commands";

export function DocumentToolbar({ editor }: { editor: Editor }) {
  const { t } = useT("editor");
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      inline_code: e.isActive("code"),
      bullet: e.isActive("bulletList"),
      task: e.isActive("taskList"),
      quote: e.isActive("blockquote"),
      table: e.isActive("table"),
    }),
  });
  const items: {
    id: keyof typeof active;
    icon: IconComponent;
    label: string;
  }[] = [
    { id: "h2", icon: Heading2, label: t(($) => $.document_commands.h2) },
    { id: "h3", icon: Heading3, label: t(($) => $.document_commands.h3) },
    { id: "bold", icon: Bold, label: t(($) => $.document_commands.bold) },
    { id: "italic", icon: Italic, label: t(($) => $.document_commands.italic) },
    {
      id: "inline_code",
      icon: Code,
      label: t(($) => $.document_commands.inline_code),
    },
    { id: "bullet", icon: List, label: t(($) => $.document_commands.bullet) },
    { id: "task", icon: ListTodo, label: t(($) => $.document_commands.task) },
    { id: "quote", icon: Quote, label: t(($) => $.document_commands.quote) },
    { id: "table", icon: Table2, label: t(($) => $.document_commands.table) },
  ];
  return (
    <div
      role="toolbar"
      aria-label={t(($) => $.document_commands.toolbar)}
      className="sticky top-0 z-10 mb-5 flex flex-wrap items-center gap-0.5 rounded-lg border border-border bg-background p-1 shadow-sm"
    >
      {items.map(({ id, icon: Icon, label }) => (
        <TooltipHint key={id} label={label}>
          <Button
            size="icon-sm"
            variant={active[id] ? "secondary" : "ghost"}
            aria-label={label}
            aria-pressed={active[id]}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runDocumentCommand(editor, id as DocumentCommand)}
          >
            <Icon />
          </Button>
        </TooltipHint>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button size="sm" variant="ghost">
              {t(($) => $.document_commands.insert)}
            </Button>
          }
        />
        <DropdownMenuContent>
          {(
            ["h2", "h3", "table", "code", "mermaid", "task", "quote"] as const
          ).map((command) => (
            <DropdownMenuItem
              key={command}
              onClick={() => runDocumentCommand(editor, command)}
            >
              {t(($) => $.document_commands[command])}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
