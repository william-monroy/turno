import { REPO } from "@/lib/layout.shared";

/** The folder of each published package in the repository, for its CHANGELOG.md. */
const PACKAGE_DIRS: Record<string, string> = {
  "turno-cli": "turno",
  "turno-browser": "browser",
  "turno-fonts": "fonts",
  "turno-core": "core",
};

export interface ReleasedPackage {
  name: string;
  version: string;
  /** The GitHub release of the `name@version` tag that the release workflow creates. */
  release: string;
  /** The section of the package's CHANGELOG.md for this version. */
  changelog: string;
}

/**
 * A package as the release pages write it: its git tag, `turno-cli@0.2.0`. A typo would link to a
 * page that does not exist, so anything unexpected fails the build instead.
 */
export function releasedPackage(tag: string): ReleasedPackage {
  const at = tag.lastIndexOf("@");
  const name = tag.slice(0, at);
  const version = tag.slice(at + 1);
  const dir = PACKAGE_DIRS[name];
  if (at <= 0 || !dir || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`release pages: "${tag}" is not <package>@<version> for a published package (${Object.keys(PACKAGE_DIRS).join(", ")})`);
  }
  return {
    name,
    version,
    release: `${REPO}/releases/tag/${encodeURIComponent(tag)}`,
    // GitHub's anchor for the heading "## 0.2.0" drops the dots.
    changelog: `${REPO}/blob/main/packages/${dir}/CHANGELOG.md#${version.replaceAll(".", "")}`,
  };
}

const LONG_DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });

/** "2026-11-17" to "November 17, 2026", the same on every machine that builds the site. */
export function releaseDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`release pages: date "${iso}" is not YYYY-MM-DD`);
  return LONG_DATE.format(new Date(`${iso}T00:00:00Z`));
}
