import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { FolderTree } from "@/components/diagrams/folder-tree";
import { GatewayDiagram } from "@/components/diagrams/gateway";
import { ScopeTree } from "@/components/diagrams/scope-tree";
import { StatusLine } from "@/components/diagrams/status-line";
import { Install } from "@/components/install";
import { Recording } from "@/components/recording";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Tab,
    Tabs,
    Step,
    Steps,
    Install,
    Recording,
    GatewayDiagram,
    FolderTree,
    StatusLine,
    ScopeTree,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
