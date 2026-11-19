"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LABEL: Record<string, string> = { en: "Tools", es: "Herramientas" };

/**
 * The two tools of the toolkit, next to the logo: turno and turno-browser. The current one is
 * the tool the page is about: turno-browser on its own page and in its docs, turno elsewhere.
 */
export function ProductSwitch({ lang, home, browser }: { lang: string; home: string; browser: string }) {
  const pathname = usePathname();
  const docs = `${home === "/" ? "" : home}/docs/browser`;
  const onBrowser = pathname === browser || pathname.startsWith(`${browser}/`) || pathname === docs || pathname.startsWith(`${docs}/`);
  return (
    <nav aria-label={LABEL[lang] ?? LABEL.en} className="d-products">
      <Link href={home} className="d-product" aria-current={onBrowser ? undefined : "true"}>
        turno
      </Link>
      <Link href={browser} className="d-product" aria-current={onBrowser ? "true" : undefined}>
        turno-browser
      </Link>
    </nav>
  );
}
