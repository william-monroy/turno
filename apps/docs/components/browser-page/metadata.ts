import type { Metadata } from "next";
import { asLang } from "../landing/copy";
import { browserCopy } from "./copy";

/** The title and description of the turno-browser page: its line, whole. */
export function browserMetadata(lang: string): Metadata {
  const t = browserCopy(asLang(lang)).hero;
  const description = `${t.headline.join("")} ${t.hook}`;
  return {
    title: "turno-browser",
    description,
    openGraph: { title: "turno-browser", description },
  };
}
