"use client";

import { type Lang, landingCopy, SECTION_IDS, type StoryId } from "../copy";
import { SESSION } from "./context";
import s from "./thread.module.css";

/*
 * Finding the way down the page. The hero's blue thread is the conversation 7f3c9a2e running
 * through the accounts; the page keeps it going as a hairline in the left gutter, from under
 * the hero to the footer. It comes down out of the hero's sky to a socket labeled with the
 * conversation's id, every chapter's label hangs on it by a knot (section.module.css), one bead of
 * light rides it at the middle of the screen (you are here), and it fades out into the footer:
 * the conversation goes on past the page. The bead is only `position: sticky`, so the scroll
 * itself moves it, with no script and nothing measured per frame. Only from 1200 px wide: under
 * that the gutter is under 48 px and the knots would touch the window's edge (on a phone it is
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

const IN_ORDER: Record<Lang, string> = {
  en: "or read it in order",
  es: "o léelo en orden",
};

/** The eight chapters in one line, by short name, in the order the thread carries them. */
export function ChapterList({ lang, where }: { lang: Lang; where: "start" | "end" }) {
  const t = landingCopy(lang);
  const label = where === "start" ? IN_ORDER[lang] : t.rail.label;
  return (
    <nav className={s.list} aria-label={t.rail.label} data-where={where}>
      <span className={s.listLabel}>{label}</span>
      <ol className={s.items}>
        {STORY_IDS.map((id) => (
          <li key={id}>
            <a href={`#${id}`} className={s.item}>
              {t.sections[id].tab}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}