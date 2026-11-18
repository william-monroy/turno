import type { ReactNode } from "react";
import { HomeLayoutView } from "@/components/routes/layouts";

export default function Layout({ children }: { children: ReactNode }) {
  return <HomeLayoutView lang="en">{children}</HomeLayoutView>;
}
