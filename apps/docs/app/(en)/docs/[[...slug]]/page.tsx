import { DocsPageView, docsMetadata, docsParams } from "@/components/routes/docs-page";

export const dynamicParams = false;

export default async function Page({ params }: PageProps<"/docs/[[...slug]]">) {
  const { slug } = await params;
  return <DocsPageView lang="en" slug={slug} />;
}

export function generateStaticParams() {
  return docsParams("en");
}

export async function generateMetadata({ params }: PageProps<"/docs/[[...slug]]">) {
  const { slug } = await params;
  return docsMetadata("en", slug);
}
