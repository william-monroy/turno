import type { ReactNode } from "react";
import { RootLayout, rootMetadata } from "@/components/routes/root";

export const metadata = rootMetadata("en");

export default function Layout({ children }: { children: ReactNode }) {
  return <RootLayout lang="en">{children}</RootLayout>;
}
