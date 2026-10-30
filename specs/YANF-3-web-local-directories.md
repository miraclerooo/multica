# Project working directories on the web

The project Resources section supports choosing a working directory on a
registered machine, entering an absolute path, editing the path and execution
mode, and removing the association. Each project has at most one directory per
daemon. Agents bound to that machine use its project directory.

## Interaction

1. Choose an unassociated local machine. Show its bound agents.
2. Choose a directory in that machine's directory browser. The browser identifies
   the target machine, starts from home/volume roots, lists directories only,
   and supports returning to a parent. Selecting a directory validates it and
   fills its absolute path. Manual entry remains available.
3. Choose direct editing or isolated worktrees and save. Worktrees require the
   existing server capability gate and a Git working tree.

Editing keeps the machine fixed and pre-fills the current path and mode.
Cancelling directory selection preserves the original value. Changing the
machine while adding clears the previous path. Failed saves keep the dialog
and entered values open. Removing a directory requires confirmation and only
deletes the resource association, never files on the machine.

Desktop additions keep the native picker. Desktop edits use it when the target
daemon ID exactly matches the desktop's daemon; machine names are not identity.
Web browsers use the daemon-backed picker for both nearby and remote machines.
Browser directory handles are never guessed into absolute paths.

## Access and compatibility

- Only the runtime owner may enumerate machine directories, including when the
  runtime is visible to other workspace members or administrators.
- Requests and result reads are bound to workspace, runtime, daemon, and caller.
  Result submission uses the existing authenticated daemon binding.
- A daemon advertises `directory-browse-v1`. Offline machines and older daemons
  show connection/upgrade guidance; manual configuration remains available and
  is checked on the machine when a run starts.
- The directory browser exposes names and paths only. File preview, file editing,
  copying files, and filesystem deletion are outside this feature.

## Protocol

- `POST /api/runtimes/{runtimeId}/directories`: enqueue `roots`, `list`, or
  `validate` with an optional absolute path; returns a request ID and status.
- `GET /api/runtimes/{runtimeId}/directories/{requestId}`: retrieve the result.
- `pending_directory_browse` on the existing daemon heartbeat carries the work.
- `POST /api/daemon/runtimes/{runtimeId}/directories/{requestId}/result`: report
  a result or error. A pending-work notification requests an immediate heartbeat.

After reporting a directory result, the daemon makes one follow-up heartbeat
after the hint throttle window. This drains a subsequent folder click that
arrived inside that window; an empty queue schedules no further work.

Production servers share requests in Redis. Requests expire after 60 seconds;
stored results expire after two minutes. Atomic claiming prevents two API nodes
from dispatching the same request. A list returns at most 200 directories and
signals truncation. The UI then offers manual path entry for omitted locations.

Browsing a parent such as the home directory is allowed; selecting it as an
agent's writable working directory is checked separately. Selection reuses the
daemon's existence, read/write, protected-root, and symlink checks and returns
the canonical path plus Git status. Execution revalidates the saved directory.
The resource model and agent task directory resolution remain unchanged.

## Verification

Daemon tests exercise directory-only listing, path validation, protected home
directories, symlink targets, and cancellation. Handler tests cover ownership,
request isolation, heartbeat delivery, terminal results, timeouts, and Redis
sharing across server instances. TypeScript tests cover malformed responses and
cancelled polling.

The browser test covers target-machine selection, automatic path filling,
persistent resource creation, editing, invalid-path blocking, and confirmed
unlinking. It uses real resource APIs with simulated daemon directory replies;
it does not execute an installed agent CLI or browse a real user's filesystem.
Deployment requires updating both the server and the target daemon before the
new directory picker is available.
