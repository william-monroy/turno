import { DocsBody, DocsDescription, DocsPage, DocsTitle, MarkdownCopyButton } from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/components/mdx";
import { REPO } from "@/lib/layout.shared";
import { source } from "@/lib/source";

const SOURCE_LABEL: Record<string, string> = { en: "View source", es: "Ver el código fuente" };

export function DocsPageView({ lang, slug }: { lang: string; slug?: string[] }) {
  const page = source.getPage(slug, lang);
  if (!page) notFound();

  const MDX = page.data.body;
  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row items-center gap-2 border-b pb-6 pt-2">
        <MarkdownCopyButton markdownUrl={`${page.url}.md`} />
        <a
          href={`${REPO}/blob/main/apps/docs/content/docs/${encodeURI(page.path)}`}
          rel="noreferrer noopener"
          target="_blank"
          className="inline-flex items-center rounded-md border bg-fd-secondary px-2 py-1.5 text-xs font-medium text-fd-secondary-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
        >
          {SOURCE_LABEL[lang] ?? SOURCE_LABEL.en}
        </a>
      </div>
      <DocsBody>
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
