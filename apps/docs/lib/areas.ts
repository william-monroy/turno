import type * as PageTree from "fumadocs-core/page-tree";
import type { ReactNode } from "react";
import { localePath } from "@/lib/layout.shared";

/**
 * The docs have three areas, each a root folder in content/docs with its own sidebar:
 * `(docs)` (a folder group, so its pages keep their URLs), `reference` and `troubleshooting`.
 */
export type AreaId = "docs" | "reference" | "troubleshooting";

const AREAS: { id: AreaId; path: string }[] = [
  { id: "docs", path: "/docs" },
  { id: "reference", path: "/docs/reference" },
  { id: "troubleshooting", path: "/docs/troubleshooting" },
];

const NAMES: Record<string, Record<AreaId, string>> = {
  en: { docs: "Docs", reference: "Reference", troubleshooting: "Troubleshooting" },
  es: { docs: "Documentación", reference: "Referencia", troubleshooting: "Solución de problemas" },
};

export interface AreaLink {
  id: AreaId;
  href: string;
  name: string;
  /** How many pages the area holds, shown next to its name. */
  count: number;
}

function countPages(nodes: PageTree.Node[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === "page") n += node.external ? 0 : 1;
    else if (node.type === "folder") n += (node.index ? 1 : 0) + countPages(node.children);
  }
  return n;
}

/** The root folder that holds an area: the one whose first page is the area's home. */
function areaFolder(tree: PageTree.Root, href: string): PageTree.Folder | undefined {
  for (const node of tree.children) {
    if (node.type !== "folder" || !node.root) continue;
    const first = node.index ?? node.children.find((child) => child.type === "page");
    if (first?.type === "page" && first.url === href) return node;
  }
  return undefined;
}

export function areaLinks(tree: PageTree.Root, lang: string): AreaLink[] {
  const names = NAMES[lang] ?? NAMES.en!;
  return AREAS.map(({ id, path }) => {
    const href = localePath(lang, path);
    const folder = areaFolder(tree, href);
    return { id, href, name: names[id], count: folder ? countPages(folder.children) : 0 };
  });
}

export interface PagePlace {
  /** The area the page belongs to, with a link to its home. */
  area: { name: string; href: string };
  /** The sidebar groups above the page inside its area: folders, then the nearest separator. */
  groups: string[];
}

/** Where a page sits in the sidebar, for the label over its title. */
export function placeOf(tree: PageTree.Root, lang: string, url: string): PagePlace | undefined {
  for (const link of areaLinks(tree, lang)) {
    const folder = areaFolder(tree, link.href);
    if (!folder) continue;
    const groups = groupsTo(folder.children, url);
    if (groups) return { area: { name: link.name, href: link.href }, groups };
  }
  return undefined;
}

/** The folder names and the last separator on the way to `url`, or undefined when it is not there. */
function groupsTo(nodes: PageTree.Node[], url: string): string[] | undefined {
  let separator: ReactNode;
  for (const node of nodes) {
    if (node.type === "separator") separator = node.name;
    else if (node.type === "page" && node.url === url) return typeof separator === "string" ? [separator] : [];
    else if (node.type === "folder") {
      if (node.index?.url === url) return typeof node.name === "string" ? [node.name] : [];
      const inner = groupsTo(node.children, url);
      if (inner) return typeof node.name === "string" ? [node.name, ...inner] : inner;
    }
  }
  return undefined;
}
