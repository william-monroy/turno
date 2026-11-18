import Link from "next/link";
import type { ReactNode } from "react";
import { releaseDate, releasedPackage } from "./data";
import { PackageChip } from "./release-header";

/**
 * Every version on one blue line, newest first: the landing's thread, with versions hanging on it
 * instead of chapters. The latest release is open (packages, a summary that names its features,
 * the way in); earlier ones are a line each.
 *
 *   <ReleaseLine>
 *   <Release latest version="0.2.0" date="2026-11-17" href="/docs/releases/v0-2-0" packages={["turno-cli@0.2.0"]}>
 *   What it brings, with the features in **bold** and linked.
 *   </Release>
 *   <Release version="0.1" date="2026-11-16" href="/docs/releases/v0-1-0">
 *   One sentence.
 *   </Release>
 *   </ReleaseLine>
 */
export function ReleaseLine({ children }: { children: ReactNode }) {
  return <ol className="d-line">{children}</ol>;
}

export function Release({
  version,
  date,
  href,
  packages = [],
  latest = false,
  children,
}: {
  version: string;
  date: string;
  href: string;
  packages?: string[];
  latest?: boolean;
  children?: ReactNode;
}) {
  const list = packages.map(releasedPackage);
  return (
    <li className="d-line-item" data-latest={latest ? "" : undefined}>
      <span aria-hidden className="d-line-knot" />
      <p className="d-line-meta">
        {latest ? <span className="d-line-flag">Latest release</span> : null}
        <time dateTime={date}>{releaseDate(date)}</time>
      </p>
      <h2 className="d-line-version">
        <Link href={href}>
          <span className="d-line-name">turno </span>
          {version}
        </Link>
      </h2>
      {list.length > 0 ? (
        <ul className="d-line-pkgs" aria-label="Packages">
          {list.map((pkg) => (
            <li key={pkg.name}>
              <PackageChip name={pkg.name} version={pkg.version} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="d-line-summary">{children}</div>
      <Link href={href} className={latest ? "d-line-go d-line-go-strong" : "d-line-go"}>
        Read the release notes<span className="sr-only"> for turno {version}</span>
        <span aria-hidden>→</span>
      </Link>
    </li>
  );
}
