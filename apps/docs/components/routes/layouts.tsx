import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactNode } from "react";
import { AreaTabs } from "@/components/docs/area-tabs";
import { areaLinks } from "@/lib/areas";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

const AREAS_LABEL: Record<string, string> = { en: "Documentation areas", es: "Secciones de la documentación" };

export function HomeLayoutView({ lang, children }: { lang: string; children: ReactNode }) {
  return <HomeLayout {...baseOptions(lang)}>{children}</HomeLayout>;
}

export function DocsLayoutView({ lang, children }: { lang: string; children: ReactNode }) {
  const tree = source.getPageTree(lang);
  return (
    <DocsLayout
      {...baseOptions(lang)}
      links={[]}
      tree={tree}
      // The areas are root folders; AreaTabs shows them as a list instead of Fumadocs' dropdown.
      tabs={false}
      sidebar={{ banner: <AreaTabs areas={areaLinks(tree, lang)} label={AREAS_LABEL[lang] ?? AREAS_LABEL.en!} /> }}
    >
      {children}
    </DocsLayout>
  );
}
