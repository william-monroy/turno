import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import type { ComponentProps } from "react";
import { FolderTree } from "@/components/diagrams/folder-tree";
import { GatewayDiagram } from "@/components/diagrams/gateway";
import { ScopeTree } from "@/components/diagrams/scope-tree";
import { StatusLine } from "@/components/diagrams/status-line";
import { Install } from "@/components/install";
import { Recording } from "@/components/recording";

const MdxImage = defaultMdxComponents.img;

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    // The site has a handful of images, so they load with the page: a lazy one stays blank in
    // print and in full-page captures until it is scrolled to.
    img: (props: ComponentProps<typeof MdxImage>) => <MdxImage {...props} loading="eager" />,
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
