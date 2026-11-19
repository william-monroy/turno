import type { Metadata } from "next";
import { browserMetadata } from "@/components/browser-page/metadata";
import { BrowserPage } from "@/components/browser-page/page";

export const metadata: Metadata = browserMetadata("es");

export default function Page() {
  return <BrowserPage lang="es" />;
}
