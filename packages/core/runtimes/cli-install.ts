export const OFFICIAL_CLI_REPOSITORY = "multica-ai/multica";
export const CLI_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function cliInstallCommands(repository = OFFICIAL_CLI_REPOSITORY) {
  const repo = repository || OFFICIAL_CLI_REPOSITORY;
  if (!CLI_REPOSITORY_PATTERN.test(repo)) throw new Error("Invalid CLI release repository");
  const base = `https://raw.githubusercontent.com/${repo}/main/scripts`;
  const custom = repo !== OFFICIAL_CLI_REPOSITORY;
  return {
    macosLinux: `curl -fsSL ${base}/install.sh | ${custom ? `MULTICA_RELEASE_REPOSITORY=${repo} ` : ""}bash`,
    windows: `${custom ? `$env:MULTICA_RELEASE_REPOSITORY='${repo}'; ` : ""}irm ${base}/install.ps1 | iex`,
  };
}
