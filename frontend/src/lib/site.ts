/**
 * One place for every outbound URL the marketing site uses, so a link can only
 * be wrong once. GitHub is the source of truth for the docs, the issues and the
 * installer.
 */

export const REPO_URL = "https://github.com/Shaurya01836/Puff";

/** The newest published release (notes + every asset attached to it). */
export const LATEST_RELEASE_URL = `${REPO_URL}/releases/latest`;

/** The full release history, newest first. */
export const RELEASES_URL = `${REPO_URL}/releases`;

/** Atom feed of releases — the footer's "Follow us" RSS link. */
export const RELEASES_FEED_URL = `${REPO_URL}/releases.atom`;

/**
 * The Windows installer attached to the newest release. The release workflow
 * always names the file `Puff-Setup.exe`, so this one URL always downloads the
 * latest build: GitHub answers with a 302 to the real asset and sends it as an
 * attachment, so the browser saves the file instead of opening a page.
 */
export const INSTALLER_URL = `${LATEST_RELEASE_URL}/download/Puff-Setup.exe`;

const BLOB_URL = `${REPO_URL}/blob/main`;

/** The docs live in the repository, so links point at the rendered Markdown. */
export const DOCS_URL = {
  readme: `${BLOB_URL}/README.md`,
  architecture: `${BLOB_URL}/docs/ARCHITECTURE.md`,
  graphSchema: `${BLOB_URL}/docs/GRAPH_SCHEMA.md`,
  install: `${BLOB_URL}/docs/INSTALL.md`,
  benchmark: `${BLOB_URL}/docs/BENCHMARK.md`,
} as const;

/** Public origin of the deployed site, used for metadata and the sitemap. */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://puff-puce-one.vercel.app"
).replace(/\/+$/, "");
