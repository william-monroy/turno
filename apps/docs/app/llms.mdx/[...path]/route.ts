import { notFound } from "next/navigation";
import { docsLlms, source } from "@/lib/source";

export const revalidate = false;
// Other paths are 404s, never cached responses.
export const dynamicParams = false;

/** Every page of every language by the path of its Markdown file: its URL plus `.md`. */
function markdownFiles() {
  const files = new Map<string, ReturnType<typeof source.getPages>[number]>();
  for (const { pages } of source.getLanguages()) {
    for (const page of pages) files.set(`${page.url}.md`, page);
  }
  return files;
}

export async function GET(_req: Request, { params }: RouteContext<"/llms.mdx/[...path]">) {
  const { path } = await params;
  const page = markdownFiles().get(`/${path.join("/")}`);
  if (!page) notFound();
  return new Response(await docsLlms.page(page), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}

export function generateStaticParams() {
  return [...markdownFiles().keys()].map((file) => ({ path: file.slice(1).split("/") }));
}
