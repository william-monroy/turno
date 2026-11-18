"use client";

import { useI18n } from "fumadocs-ui/contexts/i18n";
import type { FooterProps } from "fumadocs-ui/layouts/docs/page";
import { useFooterItems } from "fumadocs-ui/utils/use-footer-items";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TEXT: Record<string, { previous: string; next: string; label: string }> = {
  en: { previous: "Previous", next: "Next", label: "Pages around this one" },
  es: { previous: "Anterior", next: "Siguiente", label: "Páginas vecinas" },
};

/**
 * The previous and next pages, inside the current area (useFooterItems reads the sidebar of the
 * area the page is in). Two hairline cells that swap ink and paper on hover, like the landing.
 */
export function PageFooter({ items }: FooterProps) {
  const list = useFooterItems();
  const pathname = usePathname();
  const t = TEXT[useI18n().locale ?? "en"] ?? TEXT.en!;
  const index = list.findIndex((item) => item.url === pathname);
  const previous = items?.previous ?? (index > 0 ? list[index - 1] : undefined);
  const next = items?.next ?? (index !== -1 ? list[index + 1] : undefined);
  if (!previous && !next) return null;

  return (
    <nav aria-label={t.label} className="d-pager">
      {previous ? (
        <Link href={previous.url} className="d-pager-link" rel="prev">
          <span className="d-pager-dir">
            <span aria-hidden>←</span> {t.previous}
          </span>
          <span className="d-pager-name">{previous.name}</span>
        </Link>
      ) : (
        <span aria-hidden className="d-pager-empty" />
      )}
      {next ? (
        <Link href={next.url} className="d-pager-link d-pager-next" rel="next">
          <span className="d-pager-dir">
            {t.next} <span aria-hidden>→</span>
          </span>
          <span className="d-pager-name">{next.name}</span>
        </Link>
      ) : (
        <span aria-hidden className="d-pager-empty" />
      )}
    </nav>
  );
}
