"use client";

import { useEffect } from "react";
import type { PictureProps } from "../../landing/chapters/section";
import { usePhase } from "../../landing/chapters/stage";
import { browserCopy, CMD, IDENTITY_PATH, PRINTS, SITE, TOOL } from "../copy";
import { Field, Lines, Shot, type Win, Window } from "./parts";
import s from "./pictures.module.css";

/*
 * One identity, one Chrome profile. `add` creates the profile on disk; `login` opens its Chrome
 * for the person to sign in by hand and saves the session when the window closes; afterwards an
 * agent's `browser_navigate` opens the same profile, already signed in.
 */

/** The phases of each step and how many beats each holds: the typing, then what it draws. */
const BEATS: Record<number, number[]> = {
  0: [4, 1],
  1: [4, 5, 6, 1],
  2: [4, 1],
};

export default function IdentitiesPicture({ lang, chosen, run, drawn, armed, reduced, say }: PictureProps) {
  const copy = browserCopy(lang).pictures;
  const t = copy.identities;
  const beats = BEATS[chosen] ?? BEATS[0]!;
  const phase = usePhase(`${chosen}-${run}`, beats, run > 0, reduced);
  const p = run > 0 ? phase : 0;

  /* The line under the picture. */
  let prompt = "$";
  let cmd: string = CMD.add;
  let result: string | undefined;
  if (chosen === 0) {
    if (p >= 1) result = PRINTS.added;
  } else if (chosen === 1) {
    cmd = CMD.login;
    if (p >= 1) result = PRINTS.opening;
    if (p >= 3) result = t.saved;
  } else {
    prompt = "tool";
    cmd = `${TOOL.navigate} https://${SITE}/courses`;
    if (p >= 1) result = t.arrived;
  }
  useEffect(() => {
    if (run > 0) say({ prompt, cmd, result });
  }, [run, prompt, cmd, result, say]);

  /* What each step draws. The steps read in order: each starts where the last one rests. */
  const exists = chosen > 0 || p >= 1;
  const signed = chosen === 2 || (chosen === 1 && p >= 2);
  const byHand = chosen === 1 && (p === 1 || p === 2);
  const arrived = chosen === 2 && p >= 1;
  const win: Win = !exists ? "none" : byHand || arrived ? "open" : "closed";
  const url = byHand ? `${SITE}/login` : arrived ? `${SITE}/courses` : exists ? IDENTITY_PATH : "";

  return (
    <Shot drawn={drawn} armed={armed}>
      <div className={s.top}>
        <span className={s.actors}>
          <span className={s.actor} data-on={chosen < 2 || undefined}>
            {t.you}
          </span>
          <span className={s.actor} data-on={chosen === 2 || undefined}>
            {t.agent}
          </span>
        </span>
      </div>

      <Window win={win} url={url}>
        {win === "none" ? (
          <div className={s.page} data-center>
            <span className={s.quiet}>{t.none}</span>
          </div>
        ) : byHand ? (
          <div className={s.page}>
            <span className={s.form}>
              <Field name={copy.vault.username} value={p >= 2 ? "me" : undefined} />
              <Field name={copy.vault.password} value={p >= 2 ? "••••••••" : undefined} />
            </span>
            <span className={s.note}>{t.byHand}</span>
          </div>
        ) : arrived ? (
          <div className={s.page}>
            <span className={s.signed}>
              <span aria-hidden>✓</span> {t.signedIn}
            </span>
            <span className={s.heading}>{t.page}</span>
            <Lines />
          </div>
        ) : (
          <div className={s.page}>
            <span>{t.onDisk}</span>
            {signed ? (
              <span className={s.signed}>
                <span aria-hidden>✓</span> {t.signedIn} <span className={s.quiet}>· {t.kept}</span>
              </span>
            ) : (
              <span className={s.quiet}>{t.notYet}</span>
            )}
          </div>
        )}
      </Window>
    </Shot>
  );
}
