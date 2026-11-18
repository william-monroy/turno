import { uiTranslations } from "fumadocs-ui/i18n";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Logo } from "@/components/logo";
import { i18n } from "@/lib/i18n";

export const REPO = "https://github.com/wimo-dev/turno";
export const SITE = "https://turno.wimo.dev";

export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .add({
    en: { displayName: "English" },
    es: {
      displayName: "Español",
      "Search(search trigger)": "Buscar",
      "Search(search dialog)": "Buscar",
      "No results found(search dialog)": "Sin resultados",
      "On this page(table of contents)": "En esta página",
      "Table of Contents(inline table of contents)": "Contenido",
      "Next Page(pagination)": "Siguiente",
      "Previous Page(pagination)": "Anterior",
      "Copy Markdown(page actions)": "Copiar como Markdown",
      "Copied Markdown(page actions)": "Copiado",
      "Choose a language(language switcher)": "Elige un idioma",
      "Page Not Found(404 page)": "No encontramos esa página",
      "Back to Home(404 page)": "Volver al inicio",
      "Last updated on(page footer)": "Última actualización:",
      "Edit on GitHub(edit page)": "Editar en GitHub",
    },
  });

/** A path with the locale prefix: none for English, /es for Spanish. */
export function localePath(lang: string, path: string): string {
  return lang === i18n.defaultLanguage ? path : `/${lang}${path === "/" ? "" : path}`;
}

const NAV: Record<string, { docs: string; reference: string; troubleshooting: string }> = {
  en: { docs: "Docs", reference: "Reference", troubleshooting: "Troubleshooting" },
  es: { docs: "Documentación", reference: "Referencia", troubleshooting: "Solución de problemas" },
};

export function baseOptions(lang: string): BaseLayoutProps {
  const t = NAV[lang] ?? NAV.en!;
  return {
    nav: {
      title: <Logo className="h-6 w-auto" />,
      url: localePath(lang, "/"),
    },
    githubUrl: REPO,
    links: [
      { text: t.docs, url: localePath(lang, "/docs"), active: "nested-url" },
      { text: t.reference, url: localePath(lang, "/docs/reference"), active: "nested-url" },
      { text: t.troubleshooting, url: localePath(lang, "/docs/troubleshooting"), active: "nested-url" },
    ],
  };
}
