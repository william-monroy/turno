import { type NextRequest, NextResponse } from "next/server";
import { i18n } from "@/lib/i18n";

/**
 * English lives at the root and Spanish under /es: a path without a language is served as
 * English. (fumadocs-core's createI18nMiddleware also redirects /en/... back to the root, which
 * loops with this Next.js version because the rewritten request passes through here again.)
 */
export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const first = pathname.split("/")[1] ?? "";
  if ((i18n.languages as readonly string[]).includes(first)) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = `/${i18n.defaultLanguage}${pathname === "/" ? "" : pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  // Pages only: not the API, Next's own files, llms files, or anything with a file extension
  // (images, the Markdown of a page).
  matcher: ["/((?!api|_next/static|_next/image|llms|.*\\.[a-z0-9]+$).*)"],
};
