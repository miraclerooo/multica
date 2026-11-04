// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cliInstallCommands } from "./cli-install";

describe("CLI installation channel", () => {
  it("keeps both platforms on the configured repository", () => {
    const commands = cliInstallCommands("miraclerooo/multica");
    expect(commands.macosLinux).toContain("https://raw.githubusercontent.com/miraclerooo/multica/main/scripts/install.sh");
    expect(commands.macosLinux).toContain("MULTICA_RELEASE_REPOSITORY=miraclerooo/multica bash");
    expect(commands.windows).toContain("$env:MULTICA_RELEASE_REPOSITORY='miraclerooo/multica'");
    expect(commands.windows).not.toContain("multica-ai/");
  });
  it("rejects repository values that cannot be embedded in a command", () => {
    expect(() => cliInstallCommands("owner/repo;echo injected")).toThrow();
  });
});
