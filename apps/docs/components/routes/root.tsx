import "@/app/global.css";
import { i18nProvider } from "fumadocs-ui/i18n";
import { RootProvider } from "fumadocs-ui/provider/next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SITE, translations } from "@/lib/layout.shared";

const DESCRIPTION: Record<string, string> = {
  en: "Switch accounts. Keep everything else. The same session continues on your other account, with all its context, its MCP servers already signed in and its browser still logged in.",
  es: "Cambia de cuenta. Conserva todo lo demás. La misma sesión continúa en tu otra cuenta, con todo su contexto, sus servidores MCP ya con sesión iniciada y su navegador todavía con la sesión abierta.",
};

export function rootMetadata(lang: string): Metadata {
  const description = DESCRIPTION[lang] ?? DESCRIPTION.en!;
  return {
    metadataBase: new URL(SITE),
    title: { default: "turno", template: "%s · turno" },
    description,
    icons: { icon: "/icon.svg" },
    openGraph: { siteName: "turno", type: "website", description, images: ["/social-preview.png"] },
    twitter: { card: "summary_large_image" },
  };
}

/** The root layout of one language: English lives in app/(en), Spanish in app/es. */
export function RootLayout({ lang, children }: { lang: string; children: ReactNode }) {
  return (
    <html lang={lang === "es" ? "es-MX" : lang} className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider i18n={i18nProvider(translations, lang)}>{children}</RootProvider>
      </body>
    </html>
  );
}
