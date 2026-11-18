import "../global.css";
import { i18nProvider } from "fumadocs-ui/i18n";
import { RootProvider } from "fumadocs-ui/provider/next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { i18n } from "@/lib/i18n";
import { SITE, translations } from "@/lib/layout.shared";

const DESCRIPTION: Record<string, string> = {
  en: "One MCP gateway and per-folder accounts for Claude Code, Codex, Copilot CLI and Cursor CLI.",
  es: "Un gateway MCP y una cuenta por carpeta para Claude Code, Codex, Copilot CLI y Cursor CLI.",
};

export async function generateMetadata({ params }: LayoutProps<"/[lang]">): Promise<Metadata> {
  const { lang } = await params;
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

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

export default async function Layout({ params, children }: LayoutProps<"/[lang]">) {
  const { lang } = await params;
  return (
    <html lang={lang === "es" ? "es-MX" : lang} className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider i18n={i18nProvider(translations, lang)}>{children}</RootProvider>
      </body>
    </html>
  );
}
