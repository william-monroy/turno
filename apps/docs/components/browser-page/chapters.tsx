"use client";

import type { ComponentType } from "react";
import { Chapter, type PictureProps } from "../landing/chapters/section";
import { type Lang, landingCopy } from "../landing/copy";
import { browserCopy, CHAPTER_IDS, type ChapterId } from "./copy";
import IdentitiesPicture from "./pictures/identities";
import TabsPicture from "./pictures/tabs";
import VaultPicture from "./pictures/vault";

const PICTURES: Record<ChapterId, ComponentType<PictureProps>> = {
  identities: IdentitiesPicture,
  tabs: TabsPicture,
  vault: VaultPicture,
};

/** The three problems the page starts from, each with a picture the reader steps through. */
export function BrowserChapters({ lang }: { lang: Lang }) {
  const t = browserCopy(lang);
  const rail = landingCopy(lang).rail;
  return (
    <>
      {CHAPTER_IDS.map((id, index) => (
        <Chapter
          key={id}
          id={id}
          index={index}
          lang={lang}
          copy={t.chapters[id]}
          commands={t.chapters[id].commands}
          Picture={PICTURES[id]}
          labels={{ list: t.pictures.list, copy: rail.copy, copied: rail.copied, figure: t.pictures[id].figure }}
          scrollSteps
        />
      ))}
    </>
  );
}
