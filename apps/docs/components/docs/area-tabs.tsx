"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { AreaLink } from "@/lib/areas";

/**
 * The areas of the docs at the top of the sidebar. Each area is a root folder with its own
 * sidebar, so this is how a reader moves between them; the current one is filled with turno's blue,
 * like the section rail of the landing page.
 */
export function AreaTabs({ areas, label }: { areas: AreaLink[]; label: string }) {
  const pathname = usePathname();
  // Every area lives under the docs home, so the longest matching prefix is the current one.
  const current = areas
    .filter((area) => pathname === area.href || pathname.startsWith(`${area.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];

  return (
    <nav aria-label={label} className="d-areas">
      {areas.map((area) => (
        <Link key={area.id} href={area.href} className="d-area" aria-current={area === current ? "true" : undefined}>
          <span className="d-area-name">{area.name}</span>
          <span className="d-area-count" aria-hidden>
            {area.count}
          </span>
        </Link>
      ))}
    </nav>
  );
}
