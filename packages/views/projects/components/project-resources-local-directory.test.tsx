// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import type { AnchorHTMLAttributes } from "react";
import { screen } from "@testing-library/react";
import { renderWithI18n } from "../../test/i18n";
import en from "../../locales/en/projects.json";

const RESOURCE = {
  id: "res-1",
  project_id: "p1",
  workspace_id: "workspace-1",
  resource_type: "local_directory",
  resource_ref: {
    local_path: "/Users/dev/work/game-client",
    daemon_id: "daemon-1",
    label: "game-client",
    execution_mode: "worktree",
  },
  // Written by a label update (`multica project resource update --label`):
  // the column the row must read before the copy left inside the ref.
  label: "Game Client",
  position: 0,
  created_at: "2026-08-18T00:00:00Z",
  created_by: "u1",
};

const DOCUMENT_RESOURCE = {
  ...RESOURCE,
  id: "res-doc",
  resource_type: "project_document",
  resource_ref: { document_id: "doc-1", kind: "spec" },
  label: "Project specification",
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: unknown[] }) => {
    const key = options?.queryKey?.[0];
    if (key === "project-resources") return { data: [RESOURCE, DOCUMENT_RESOURCE] };
    return { data: [] };
  },
  queryOptions: (options: unknown) => options,
}));

vi.mock("@multica/core/projects", () => ({
  projectResourcesOptions: () => ({ queryKey: ["project-resources"], queryFn: vi.fn() }),
  useCreateProjectResource: () => ({ mutateAsync: vi.fn() }),
  useUpdateProjectResource: () => ({ mutateAsync: vi.fn() }),
  useDeleteProjectResource: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@multica/core/config", () => ({
  useConfigStore: (selector: (state: { localWorktreeSupported: boolean }) => unknown) =>
    selector({ localWorktreeSupported: true }),
}));

vi.mock("@multica/core/runtimes", () => ({
  runtimeListOptions: () => ({ queryKey: ["runtimes"], queryFn: vi.fn() }),
  runtimeAdvertisesLocalWorktree: () => true,
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => ({ id: "workspace-1", slug: "ws", repos: [] }),
  useWorkspacePaths: () => ({ projectDetail: (id: string) => `/ws/projects/${id}` }),
}));
vi.mock("../../navigation", () => ({
  AppLink: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}));
vi.mock("../../platform/local-directory", () => ({
  isDesktopShell: () => true,
  pickDirectory: vi.fn(),
  validateLocalDirectory: vi.fn(),
}));
vi.mock("../../platform/use-local-daemon-status", () => ({
  useLocalDaemonStatus: () => ({ daemonId: "daemon-1", deviceName: "MacBook", running: true }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProjectResourcesSection } from "./project-resources-section";

const strings = en.resources;

describe("ProjectResourcesSection — local directory row", () => {
  it("keeps the document link alongside directory controls without offering to unlink managed documents", () => {
    renderWithI18n(<ProjectResourcesSection projectId="p1" />);
    expect(screen.getByRole("link", { name: "Project specification" })).toHaveAttribute(
      "href", "/ws/projects/p1?view=docs&document=doc-1",
    );
    expect(screen.getByRole("button", { name: en.directory_config.edit_title })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: strings.remove_tooltip })).toHaveLength(1);
  });

  // The read-order matrix lives in local-directory-label.test.ts; this pins
  // the row to that helper so a label set through the API is what people see.
  it("names the row from the top-level label, not the copy inside the ref", () => {
    renderWithI18n(<ProjectResourcesSection projectId="p1" />);
    expect(screen.getByText("Game Client")).toBeInTheDocument();
    expect(screen.queryByText("game-client")).not.toBeInTheDocument();
  });

  // Editing changes the actual path and mode rather than only the row label.
  it("offers path/mode editing and remove actions, and no rename", () => {
    renderWithI18n(<ProjectResourcesSection projectId="p1" />);
    expect(screen.getByRole("button", { name: en.directory_config.edit_title })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: strings.remove_tooltip })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /rename/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
