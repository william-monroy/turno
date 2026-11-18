import { llms, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/plugins/lucide-icons";
import { defineDocs } from "fumadocs-mdx/macro";
import { i18n } from "@/lib/i18n";

const docs = defineDocs({
  dir: "content/docs",
  docs: {
    // The processed Markdown of each page feeds llms.txt and the "copy as Markdown" button.
    postprocess: { includeProcessedMarkdown: true },
  },
});

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
  i18n,
  plugins: [lucideIconsPlugin()],
});

/** llms.txt, llms-full.txt and one Markdown file per page (app/llms.*). */
export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${page.data.description ?? ""}

${await page.data.getText("processed")}`,
});
