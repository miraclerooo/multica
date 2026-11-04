import type { Metadata } from "next";
import { fetchLatestRelease } from "@/features/landing/utils/github-release";
import { DownloadClient } from "./download-client";

// Vercel ISR: the server fetch inside fetchLatestRelease carries
// `next: { revalidate: 300 }`, which makes GitHub API cost at most
// one request per region per 5 minutes. Page-level revalidate mirrors
// that window so the first paint also refreshes every 5 minutes.
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Download Multica",
  description:
    "Download Multica for macOS, Windows, or Linux — or install the CLI for servers and remote dev boxes.",
  openGraph: {
    title: "Download Multica",
    description:
      "Get the Multica desktop app with a bundled daemon, or install the CLI for servers and remote dev boxes.",
    url: "/download",
  },
  alternates: {
    canonical: "/download",
  },
};

export default async function DownloadPage() {
  const repository = process.env.MULTICA_CLI_RELEASE_REPOSITORY || "multica-ai/multica";
  const release = await fetchLatestRelease(repository);
  return <DownloadClient release={release} repository={repository}
    serverUrl={process.env.MULTICA_DAEMON_SERVER_URL || process.env.MULTICA_PUBLIC_URL}
    appUrl={process.env.MULTICA_APP_URL} />;
}
