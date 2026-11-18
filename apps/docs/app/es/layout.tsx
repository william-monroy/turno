import type { ReactNode } from "react";
import { RootLayout, rootMetadata } from "@/components/routes/root";

export const metadata = rootMetadata("es");

export default function Layout({ children }: { children: ReactNode }) {
  return <RootLayout lang="es">{children}</RootLayout>;
}
