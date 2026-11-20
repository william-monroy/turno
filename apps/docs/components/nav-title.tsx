"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { LogoMark } from "./logo";

/**
 * The header's link home: the mark. It does not prefetch: the home page's own styles would be
 * preloaded on every other page and never used there, which browsers warn about.
 */
export function NavTitle({ href = "/", ...props }: ComponentProps<"a">) {
  return (
    <Link href={href} prefetch={false} {...props}>
      <LogoMark className="h-5 w-auto" />
    </Link>
  );
}
