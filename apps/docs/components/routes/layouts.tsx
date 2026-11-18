import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactNode } from "react";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export function HomeLayoutView({ lang, children }: { lang: string; children: ReactNode }) {
  return <HomeLayout {...baseOptions(lang)}>{children}</HomeLayout>;
}

export function DocsLayoutView({ lang, children }: { lang: string; children: ReactNode }) {
  return (
    <DocsLayout {...baseOptions(lang)} links={[]} tree={source.getPageTree(lang)}>
      {children}
    </DocsLayout>
  );
}
