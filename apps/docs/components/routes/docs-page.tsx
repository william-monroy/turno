import { DocsBody, DocsDescription, DocsPage, DocsTitle, MarkdownCopyButton } from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageFooter } from "@/components/docs/page-footer";
import { getMDXComponents } from "@/components/mdx";
import { placeOf } from "@/lib/areas";
import { i18n } from "@/lib/i18n";
import { REPO } from "@/lib/layout.shared";
import { source } from "@/lib/source";

const TEXT: Record<string, { source: string; fallback?: string }> = {
  en: { source: "View source" },
  es: {
    source: "Ver el código fuente",
    fallback: "Esta página todavía no está traducida, así que la ves en inglés.",
  },
};

type DocsSourcePage = NonNullable<ReturnType<typeof source.getPage>>;

/**
 * Whether a page of another language is the English page standing in for a missing translation:
 * the loader gives every language the English files it does not have, as the same objects.
 */
function isFallback(page: DocsSourcePage, lang: string, slug?: string[]): boolean {
  if (lang === i18n.defaultLanguage) return false;
  return source.getPage(slug, i18n.defaultLanguage)?.data === page.data;
}

/** The file of a page in the repository: `page.path` names the English file even for a translation. */
function sourceFile(page: DocsSourcePage): string {
  const marker = "/content/docs/";
  const at = page.absolutePath?.lastIndexOf(marker) ?? -1;
  return at === -1 ? page.path : page.absolutePath!.slice(at + marker.length);
}

export function DocsPageView({ lang, slug }: { lang: string; slug?: string[] }) {
  const page = source.getPage(slug, lang);
  if (!page) notFound();

  const t = TEXT[lang] ?? TEXT.en!;
  const fallback = isFallback(page, lang, slug) && t.fallback;
  // The English text of a fallback page says so to screen readers and translators.
  const contentLang = fallback ? i18n.defaultLanguage : undefined;
  const place = placeOf(source.getPageTree(lang), lang, page.url);
  const MDX = page.data.body;
  return (
    <DocsPage toc={page.data.toc} full={page.data.full} breadcrumb={{ enabled: false }} slots={{ footer: PageFooter }}>
      <header className="d-head">
        {fallback ? <p className="d-fallback">{fallback}</p> : null}
        {place ? (
          <p className="d-eyebrow">
            <Link href={place.area.href}>{place.area.name}</Link>
            {place.groups.map((group) => (
              <span key={group}>
                <span aria-hidden className="d-eyebrow-sep">
                  /
                </span>
                {group}
              </span>
            ))}
          </p>
        ) : null}
        <DocsTitle lang={contentLang} className="d-title">
          {page.data.title}
        </DocsTitle>
        <DocsDescription lang={contentLang} className="d-description">
          {page.data.description}
        </DocsDescription>
        <div className="d-actions">
          <MarkdownCopyButton markdownUrl={`${page.url}.md`} className="d-action" />
          <a href={`${REPO}/blob/main/apps/docs/content/docs/${encodeURI(sourceFile(page))}`} rel="noreferrer noopener" target="_blank" className="d-action">
            {t.source}
          </a>
        </div>
      </header>
      <DocsBody lang={contentLang}>
        <MDX components={getMDXComponents({ a: createRelativeLink(source, page) })} />
      </DocsBody>
    </DocsPage>
  );
}

/** The slugs of one language, for generateStaticParams. */
export function docsParams(lang: string) {
  return source
    .generateParams()
    .filter((p) => p.lang === lang)
    .map((p) => ({ slug: p.slug }));
}

export function docsMetadata(lang: string, slug?: string[]): Metadata {
  const page = source.getPage(slug, lang);
  if (!page) notFound();
  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { types: { "text/markdown": `${page.url}.md` } },
  };
}
