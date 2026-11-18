import { DocsPageView, docsMetadata, docsParams } from "@/components/routes/docs-page";

export const dynamicParams = false;

export default async function Page({ params }: PageProps<"/es/docs/[[...slug]]">) {
  const { slug } = await params;
  return <DocsPageView lang="es" slug={slug} />;
}

export function generateStaticParams() {
  return docsParams("es");
}

export async function generateMetadata({ params }: PageProps<"/es/docs/[[...slug]]">) {
  const { slug } = await params;
  return docsMetadata("es", slug);
}
