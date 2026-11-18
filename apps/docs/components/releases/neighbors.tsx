"use client";

import { useFooterItems } from "fumadocs-ui/utils/use-footer-items";
import Link from "next/link";
import { usePathname } from "next/navigation";

const VERSION_PAGE = /\/docs\/releases\/v[\d-]+$/;

/**
 * The older and newer release, at the top of a release page. The page footer walks the sidebar
 * (newest first, so its "Next" is an older version and the first "Previous" is the list of
 * releases); these say which way in time they go, for a reader catching up version by version.
 * Both come from the sidebar, so a new page needs no edit here or on its neighbors.
 */
export function ReleaseNeighbors() {
  const pathname = usePathname();
  const versions = useFooterItems().filter((item) => VERSION_PAGE.test(item.url));
  const index = versions.findIndex((item) => item.url === pathname);
  if (index === -1 || versions.length < 2) return null;
  const newer = versions[index - 1];
  const older = versions[index + 1];

  return (
    <nav aria-label="Other versions" className="d-rel-nav">
      {older ? (
        <Link href={older.url} className="d-rel-step">
          <span aria-hidden>←</span>
          <span className="d-rel-step-dir">Older</span>
          <span className="d-rel-step-name">{older.name}</span>
        </Link>
      ) : (
        <span className="d-rel-step d-rel-step-none">
          <span className="d-rel-step-dir">The first release</span>
        </span>
      )}
      {newer ? (
        <Link href={newer.url} className="d-rel-step">
          <span className="d-rel-step-dir">Newer</span>
          <span className="d-rel-step-name">{newer.name}</span>
          <span aria-hidden>→</span>
        </Link>
      ) : (
        <span className="d-rel-step d-rel-step-none">
          <span className="d-rel-step-dir">The latest release</span>
        </span>
      )}
    </nav>
  );
}
