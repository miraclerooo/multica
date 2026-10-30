"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@multica/core/auth";
import { useConfigStore } from "@multica/core/config";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  useCreateProjectResource,
  useUpdateProjectResource,
} from "@multica/core/projects";
import {
  directoryBrowseOptions,
  isAbsoluteDirectoryPath,
  resolveDirectoryBrowse,
} from "@multica/core/runtimes";
import type {
  Agent,
  LocalDirectoryExecutionMode,
  LocalDirectoryResourceRef,
  ProjectResource,
} from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { ArrowLeft, FolderOpen } from "@multica/ui/icons";
import { ActorAvatar } from "../../common/actor-avatar";
import { useT } from "../../i18n";
import {
  isDesktopShell,
  pickDirectory,
  validateLocalDirectory,
} from "../../platform";
import type { RuntimeMachine } from "../../runtimes/components/runtime-machines";
import { LocalDirectoryModeOptions } from "./local-directory-mode-dialog";

type LocalResource = ProjectResource & {
  resource_ref: LocalDirectoryResourceRef;
};

export function MachineAgents({
  machine,
  agents,
}: {
  machine?: RuntimeMachine;
  agents: Agent[];
}) {
  const { t } = useT("projects");
  const runtimeIds = new Set(machine?.runtimes.map((runtime) => runtime.id));
  const linked = agents.filter(
    (agent) => !agent.archived_at && runtimeIds.has(agent.runtime_id ?? ""),
  );
  return (
    <div className="flex flex-wrap items-center gap-1 text-micro text-muted-foreground">
      {linked.length === 0
        ? t(($) => $.directory_config.no_agents)
        : linked.map((agent) => (
            <span
              key={agent.id}
              className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-0.5"
            >
              <ActorAvatar
                actorType="agent"
                actorId={agent.id}
                name={agent.name}
                size="xs"
                profileLink={false}
              />
              <span className="truncate">{agent.name}</span>
            </span>
          ))}
    </div>
  );
}

export function LocalDirectoryConfigDialog({
  projectId,
  resources,
  machines,
  agents,
  localDaemonId,
  resource,
  onClose,
}: {
  projectId: string;
  resources: ProjectResource[];
  machines: RuntimeMachine[];
  agents: Agent[];
  localDaemonId: string | null;
  resource?: LocalResource;
  onClose: () => void;
}) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const userId = useAuthStore((state) => state.user?.id);
  const serverValidatesWorktree = useConfigStore(
    (state) => state.localWorktreeSupported,
  );
  const attached = new Set(
    resources
      .filter((r) => r.resource_type === "local_directory")
      .map((r) => (r.resource_ref as LocalDirectoryResourceRef).daemon_id),
  );
  const initial =
    machines.find(
      (m) => m.daemonId === localDaemonId && !attached.has(m.daemonId!),
    ) ?? machines.find((m) => !attached.has(m.daemonId!));
  const [daemonId, setDaemonId] = useState(
    resource?.resource_ref.daemon_id ?? initial?.daemonId ?? "",
  );
  const [path, setPath] = useState(resource?.resource_ref.local_path ?? "");
  const [mode, setMode] = useState<LocalDirectoryExecutionMode>(
    resource?.resource_ref.execution_mode === "worktree"
      ? "worktree"
      : "in_place",
  );
  const [manual, setManual] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [browsePath, setBrowsePath] = useState("");
  const [filter, setFilter] = useState("");
  const [isGitRepo, setIsGitRepo] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const create = useCreateProjectResource(wsId, projectId);
  const update = useUpdateProjectResource(wsId, projectId);
  const machine = machines.find((m) => m.daemonId === daemonId);
  const runtime = machine?.runtimes.toSorted(
    (a, b) =>
      Number(b.status === "online") - Number(a.status === "online") ||
      Date.parse(b.last_seen_at ?? b.updated_at) -
        Date.parse(a.last_seen_at ?? a.updated_at),
  )[0];
  const owned = runtime?.owner_id === userId;
  const native =
    isDesktopShell() && Boolean(localDaemonId) && daemonId === localDaemonId;
  const capabilities = runtime?.metadata?.capabilities;
  const capable =
    Array.isArray(capabilities) && capabilities.includes("directory-browse-v1");
  const canBrowse =
    native || (owned && machine?.health === "online" && capable);
  const browse = useQuery({
    ...directoryBrowseOptions(wsId, runtime?.id, browsePath),
    enabled: browsing && Boolean(runtime?.id) && canBrowse && !native,
  });
  const unavailable =
    !owned && !native
      ? t(($) => $.directory_config.owner_only)
      : machine?.health !== "online"
        ? t(($) => $.directory_config.offline_hint)
        : t(($) => $.directory_config.upgrade_hint);
  const pathValid = isAbsoluteDirectoryPath(path) && !path.includes("\0");
  const saving = busy || create.isPending || update.isPending;

  async function validate(pathToValidate: string) {
    if (native) {
      const result = await validateLocalDirectory(pathToValidate);
      if (!result.ok)
        throw new Error(
          result.error ?? t(($) => $.resources.toast_local_pick_failed),
        );
      return { path: pathToValidate, is_git_repo: result.is_git_repo };
    }
    if (!runtime) throw new Error(t(($) => $.directory_config.no_machines));
    abort.current?.abort();
    abort.current = new AbortController();
    return resolveDirectoryBrowse(
      runtime.id,
      { operation: "validate", path: pathToValidate },
      abort.current.signal,
    );
  }

  async function chooseDirectory() {
    setError("");
    if (!native) {
      setBrowsePath(path);
      setFilter("");
      setBrowsing(true);
      return;
    }
    setBusy(true);
    try {
      const result = await pickDirectory();
      if (!result.ok) {
        if (result.reason !== "cancelled")
          setError(
            result.error ?? t(($) => $.resources.toast_local_pick_failed),
          );
        return;
      }
      const checked = await validate(result.path ?? "");
      setPath(checked.path);
      setIsGitRepo(checked.is_git_repo);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : t(($) => $.resources.toast_local_pick_failed),
      );
    } finally {
      setBusy(false);
    }
  }

  async function chooseCurrentDirectory() {
    if (!browse.data?.path || saving) return;
    setBusy(true);
    setError("");
    try {
      const checked = await validate(browse.data.path);
      setPath(checked.path);
      setIsGitRepo(checked.is_git_repo);
      setBrowsing(false);
      setManual(false);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : t(($) => $.resources.toast_local_pick_failed),
      );
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!daemonId || !pathValid || saving) return;
    setBusy(true);
    setError("");
    try {
      let nextPath = path.trim();
      let git = isGitRepo;
      if (canBrowse) {
        const checked = await validate(nextPath);
        nextPath = checked.path;
        git = checked.is_git_repo;
        setIsGitRepo(git);
      }
      if (mode === "worktree" && (git === false || !serverValidatesWorktree)) {
        throw new Error(
          git === false
            ? t(($) => $.resources.mode_worktree_needs_git)
            : t(($) => $.resources.mode_worktree_needs_server_upgrade),
        );
      }
      const basename =
        nextPath
          .replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .at(-1) || nextPath;
      const pathChanged = resource?.resource_ref.local_path !== nextPath;
      const ref: LocalDirectoryResourceRef = {
        ...resource?.resource_ref,
        daemon_id: daemonId,
        local_path: nextPath,
        label: resource && !pathChanged ? resource.resource_ref.label : basename,
        execution_mode: mode,
      };
      if (resource) {
        await update.mutateAsync({
          resourceId: resource.id,
          data: { ...(pathChanged ? { label: basename } : {}), resource_ref: ref },
        });
      } else {
        await create.mutateAsync({
          resource_type: "local_directory",
          resource_ref: ref,
        });
      }
      onClose();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : t(($) => $.resources.toast_attach_failed),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {browsing
              ? t(($) => $.directory_config.browse_title, {
                  machine: machine?.title,
                })
              : resource
                ? t(($) => $.directory_config.edit_title)
                : t(($) => $.resources.add_local_directory_button)}
          </DialogTitle>
        </DialogHeader>
        {browsing ? (
          <>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() => {
                  setBrowsePath("");
                  setError("");
                }}
              >
                {t(($) => $.directory_config.locations)}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t(($) => $.directory_config.parent)}
                disabled={!browse.data?.parent || saving}
                onClick={() => {
                  setBrowsePath(browse.data!.parent);
                  setError("");
                }}
              >
                <ArrowLeft className="size-4" />
              </Button>
              <span
                className="min-w-0 truncate font-mono text-caption"
                title={browse.data?.path ?? browsePath}
              >
                {browse.data?.path ?? browsePath}
              </span>
            </div>
            <Input
              aria-label={t(($) => $.directory_config.filter)}
              placeholder={t(($) => $.directory_config.filter)}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <div className="min-h-40 max-h-64 overflow-y-auto rounded-md border">
              {browse.isFetching ? (
                <div className="flex items-center justify-center gap-2 p-6 text-caption">
                  <Spinner />
                  {t(($) => $.directory_config.loading)}
                </div>
              ) : browse.error ? (
                <div className="p-3 text-caption">
                  <p role="alert">{browse.error.message}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void browse.refetch()}
                  >
                    {t(($) => $.directory_config.retry)}
                  </Button>
                </div>
              ) : (
                <>
                  {browse.data?.entries
                    .filter((entry) =>
                      entry.name.toLowerCase().includes(filter.toLowerCase()),
                    )
                    .map((entry) => (
                      <button
                        type="button"
                        key={entry.path}
                        disabled={saving}
                        onClick={() => {
                          setBrowsePath(entry.path);
                          setFilter("");
                          setError("");
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-body hover:bg-accent focus-visible:outline-ring"
                      >
                        <FolderOpen className="size-4 shrink-0" />
                        <span className="truncate">{entry.name}</span>
                      </button>
                    ))}
                  {browse.data?.entries.length === 0 && (
                    <p className="p-3 text-caption text-muted-foreground">
                      {t(($) => $.directory_config.empty_directory)}
                    </p>
                  )}
                </>
              )}
            </div>
            {browse.data?.truncated && (
              <p className="text-caption text-muted-foreground">
                {t(($) => $.directory_config.truncated)}
              </p>
            )}
          </>
        ) : (
          <>
            <label className="space-y-1 text-caption">
              <span>{t(($) => $.directory_config.machine)}</span>
              {resource ? (
                <div className="rounded-md border bg-muted px-3 py-2">
                  {machine?.title ?? daemonId}
                </div>
              ) : (
                <select
                  className="h-9 w-full rounded-md border bg-background px-2 text-body"
                  value={daemonId}
                  disabled={saving}
                  onChange={(event) => {
                    setDaemonId(event.target.value);
                    setPath("");
                    setIsGitRepo(undefined);
                    setError("");
                    setManual(false);
                  }}
                >
                  {!daemonId && (
                    <option value="">
                      {t(($) => $.directory_config.choose_machine)}
                    </option>
                  )}
                  {machines.map((item) => (
                    <option
                      key={item.id}
                      value={item.daemonId!}
                      disabled={attached.has(item.daemonId!)}
                    >
                      {item.title}
                      {attached.has(item.daemonId!)
                        ? ` · ${t(($) => $.resources.attached_badge)}`
                        : item.health !== "online"
                          ? ` · ${t(($) => $.directory_config.offline)}`
                          : ""}
                    </option>
                  ))}
                </select>
              )}
            </label>
            {machines.length === 0 && (
              <p className="text-caption text-muted-foreground">
                {t(($) => $.directory_config.no_machines)}
              </p>
            )}
            <MachineAgents machine={machine} agents={agents} />
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-caption">
                  {t(($) => $.directory_config.path)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canBrowse || saving || !daemonId}
                  onClick={() => void chooseDirectory()}
                >
                  <FolderOpen className="size-4" />
                  {t(($) => $.directory_config.choose)}
                </Button>
              </div>
              {path && !manual && (
                <div className="rounded-md bg-muted p-2 font-mono text-caption break-all">
                  {path}
                </div>
              )}
              {manual && (
                <Input
                  aria-label={t(($) => $.directory_config.path)}
                  value={path}
                  disabled={saving}
                  onChange={(event) => {
                    setPath(event.target.value);
                    setIsGitRepo(undefined);
                    setError("");
                  }}
                  aria-invalid={Boolean(path) && !pathValid}
                />
              )}
              <Button
                variant="link"
                size="sm"
                disabled={saving}
                onClick={() => setManual(!manual)}
              >
                {t(($) => $.directory_config.manual)}
              </Button>
              {manual && path && !pathValid && (
                <p role="alert" className="text-caption text-destructive">
                  {t(($) => $.directory_config.absolute_required)}
                </p>
              )}
              {daemonId && !canBrowse && (
                <p className="text-caption text-muted-foreground">
                  {unavailable}
                </p>
              )}
              {!canBrowse && manual && (
                <p className="text-caption text-muted-foreground">
                  {t(($) => $.directory_config.pending_validation)}
                </p>
              )}
            </div>
            <LocalDirectoryModeOptions
              value={mode}
              onChange={(next) => {
                if (!saving) setMode(next);
              }}
              unavailableReason={
                !serverValidatesWorktree
                  ? "server_outdated"
                  : isGitRepo === false
                    ? "not_git"
                    : undefined
              }
            />
          </>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 p-2 text-caption text-destructive"
          >
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => {
              if (browsing) {
                setBrowsing(false);
                setError("");
              } else onClose();
            }}
          >
            {t(($) => $.resources.mode_cancel)}
          </Button>
          <Button
            aria-busy={saving}
            disabled={
              saving ||
              (browsing
                ? !browse.data?.path ||
                  browse.isFetching ||
                  Boolean(browse.error)
                : !daemonId ||
                  !pathValid ||
                  (mode === "worktree" &&
                    (isGitRepo === false || !serverValidatesWorktree)))
            }
            onClick={() => void (browsing ? chooseCurrentDirectory() : save())}
          >
            {saving && <Spinner className="size-4" />}
            {browsing
              ? t(($) => $.directory_config.use_folder)
              : resource
                ? t(($) => $.resources.mode_save)
                : t(($) => $.resources.mode_add)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
