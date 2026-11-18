"use client";

import { type Lang, landingCopy, SECTION_IDS, type StoryId } from "../copy";
import { SESSION } from "./context";
import s from "./thread.module.css";

/*
 * Finding the way down the page. The hero's blue thread is the conversation 7f3c9a2e running
 * through the accounts; the page keeps it going as a hairline in the left gutter, from under
 * the hero to the footer. It comes down out of the hero's sky to a socket labeled with the
 * conversation's id, every chapter's number hangs on it (section.module.css, .knot), one bead of
 * light rides it at the middle of the screen (you are here), and it fades out into the footer:
 * the conversation goes on past the page. The bead is only `position: sticky`, so the scroll
 * itself moves it, with no script and nothing measured per frame. Only from 1200 px wide: under
 * that the gutter is under 48 px and the numbers would touch the window's edge (on a phone it is
 * 20 px, and a line there would crowd the text and the pictures' own blue bar).
 */

const STORY_IDS = SECTION_IDS.filter((id): id is StoryId => id !== "hero");

export function Thread() {
  return (
    <div aria-hidden className={s.thread}>
      <span className={s.socket} />
      <span className={s.id}>{SESSION}</span>
      <span className={s.bead} />
    </div>
  );
}

const WORDS: Record<Lang, { inOrder: string; chapters: string }> = {
  en: { inOrder: "or read it in order", chapters: "Chapters" },
  es: { inOrder: "o léelo en orden", chapters: "Capítulos" },
};

/** The eight chapters in one line, by number and short name: the numbers the thread carries. */
export function ChapterList({ lang, where }: { lang: Lang; where: "start" | "end" }) {
  const t = landingCopy(lang);
  const words = WORDS[lang];
  const label = where === "start" ? words.inOrder : words.chapters;
  return (
    <nav className={s.list} aria-label={words.chapters} data-where={where}>
      <span className={s.listLabel}>{label}</span>
      <ol className={s.items}>
        {STORY_IDS.map((id, index) => (
          <li key={id}>
            <a href={`#${id}`} className={s.item}>
              <span className={s.itemN}>{String(index + 1).padStart(2, "0")}</span>
              {t.sections[id].tab}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}