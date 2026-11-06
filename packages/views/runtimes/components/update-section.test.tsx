// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configStore } from "@multica/core/config";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enRuntimes from "../../locales/en/runtimes.json";
import { UpdateSection } from "./update-section";

const TEST_RESOURCES = { en: { common: enCommon, runtimes: enRuntimes } };

vi.mock("@multica/core/api", () => ({
  api: {
    initiateUpdate: vi.fn(),
    getUpdateResult: vi.fn(),
  },
}));

function renderSection(props: {
  runtimeId: string | null;
  launchedBy?: string | null;
  currentVersion?: string;
}) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <UpdateSection
          runtimeId={props.runtimeId}
          currentVersion={props.currentVersion ?? "v0.4.0"}
          isOnline
          launchedBy={props.launchedBy}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  configStore.getState().setDaemonConfig({ daemonSetupTarget: "cloud" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("UpdateSection release source", () => {
  it("waits for config and uses separate release data for each repository", async () => {
    const fetchRelease = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tag_name: "v0.4.20" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tag_name: "v0.4.0" }) });
    vi.stubGlobal("fetch", fetchRelease);
    configStore.getState().setDaemonConfigStatus("loading");
    renderSection({ runtimeId: "runtime-1" });

    expect(fetchRelease).not.toHaveBeenCalled();
    act(() => configStore.getState().setDaemonConfigStatus("error"));
    expect(fetchRelease).not.toHaveBeenCalled();

    act(() => configStore.getState().setDaemonConfig({
      daemonSetupTarget: "self_host",
      cliReleaseRepository: "example-org/multica",
    }));
    expect(await screen.findByText("v0.4.20")).toBeInTheDocument();
    expect(fetchRelease).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/example-org/multica/releases/latest",
      expect.anything(),
    );
    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();

    act(() => configStore.getState().setDaemonConfig({ daemonSetupTarget: "cloud" }));
    expect(await screen.findByText("Latest")).toBeInTheDocument();
    expect(fetchRelease).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/multica-ai/multica/releases/latest",
      expect.anything(),
    );
  });
});

describe("UpdateSection read-only status", () => {
  it("shows Latest without a redundant read-only label or update action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: "v0.4.0" }),
      }),
    );

    renderSection({ runtimeId: null });

    expect(await screen.findByText("Latest")).toBeInTheDocument();
    expect(screen.queryByText("Read-only")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Update" }),
    ).not.toBeInTheDocument();
  });

  it("shows the Desktop manager without exposing an update action", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: "v0.4.0" }),
      }),
    );

    renderSection({ runtimeId: null, launchedBy: "desktop" });

    expect(screen.getByText("Managed by Desktop")).toBeInTheDocument();
    expect(screen.queryByText("Read-only")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Update" }),
    ).not.toBeInTheDocument();
  });

  it("shows an available version without an action for a read-only viewer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: "v0.4.0" }),
      }),
    );

    renderSection({ runtimeId: null, currentVersion: "v0.3.17" });

    expect(await screen.findByText("available")).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(
      screen.getByTitle(
        "Only runtime owners and workspace admins can update the CLI.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Update" }),
    ).not.toBeInTheDocument();
  });
});

// A daemon built from source reports either the ldflags default ("dev") or a
// `git describe` string. Neither can be ordered against a release tag, so the
// UI must not claim an upgrade is available — a manual update is legitimate
// precisely because a human made an informed decision, and that decision has to
// rest on something we actually parsed.
describe("UpdateSection non-release versions", () => {
  const LATEST = "v0.4.20";

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: LATEST }),
      }),
    );
  });

  const NON_RELEASE_VERSIONS = [
    "dev",
    "v0.4.17-12-gabc1234",
    "v0.4.17-dirty",
    "v0.4.17-rc1",
    "v0.4",
  ];

  for (const currentVersion of NON_RELEASE_VERSIONS) {
    it(`offers no update and claims no state for "${currentVersion}"`, async () => {
      renderSection({ runtimeId: "runtime-1", currentVersion });

      expect(await screen.findByText("Local build")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Update" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("available")).not.toBeInTheDocument();
      // "Latest" would be just as unfounded as "update available".
      expect(screen.queryByText("Latest")).not.toBeInTheDocument();
    });
  }

  it("still offers the update on a release version behind the latest", async () => {
    renderSection({ runtimeId: "runtime-1", currentVersion: "v0.4.17" });

    expect(
      await screen.findByRole("button", { name: "Update" }),
    ).toBeInTheDocument();
    expect(screen.getByText("available")).toBeInTheDocument();
    expect(screen.queryByText("Local build")).not.toBeInTheDocument();
  });

  it("reports a release version on the latest tag as Latest", async () => {
    renderSection({ runtimeId: "runtime-1", currentVersion: LATEST });

    expect(await screen.findByText("Latest")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Update" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Local build")).not.toBeInTheDocument();
  });
});
