"use client";

import type { CSSProperties } from "react";
import { useEffect } from "react";
import { type Lang, landingCopy } from "../copy";
import type { Tone } from "../kit";
import s from "./accounts.module.css";
import type { ChapterCommand, PictureProps } from "./section";
import { type Lane, place, Stage, TRAVEL, usePhase } from "./stage";

/*
 * Chapter 5: folder rules, as docs/concepts/folder-rules.mdx describes them. `turno profile
 * assign` writes a [[projects]] rule into config.toml and prints `<dir> -> <profile>`
 * (cli/commands/profile.ts). `turno auto` takes the rule with the longest matching path, so a
 * subfolder goes with its parent; a folder without a rule uses `default`. Before it opens the
 * agent it says which account and why on stderr: `turno: account <p> (project <dir>)` or
 * `turno: account <p> (folder without a rule)` (cli/commands/auto.ts, core/resolve.ts).
 */

const ACME = "~/code/acme";
const API = `${ACME}/api`;
const BLOG = "~/code/blog";

export const ACCOUNTS_TEXT = {
  en: {
    figure: "Two accounts, and the folders that open with each. Choose a command to run it here.",
    default: "the default account",
    login: "its own login",
    open: "claude",
  },
  es: {
    figure: "Dos cuentas y las carpetas que abren con cada una. Elige un comando para correrlo aquí.",
    default: "la cuenta por defecto",
    login: "su propio inicio de sesión",
    open: "claude",
  },
};

/** The section's commands from copy.ts: both are typed in a shell. */
export function accountsCommands(lang: Lang): ChapterCommand[] {
  return landingCopy(lang).sections.accounts.commands.map((command) => ({ ...command, prompt: "$" }));
}

const HALF = TRAVEL / 2;
const BEATS: Record<number, number[]> = {
  // type, the rule is written, travel to the hairline, on to the lane, landed
  0: [4, 3, HALF, HALF + 1, 1],
  // type in blog, it opens as personal, type in api, it opens as work
  1: [4, 4, 4, 1],
};

/*
 * Where each folder sits in its lane, from accounts.module.css: side by side, ~/code/acme
 * crosses straight over and ~/code/blog stays low; stacked, ~/code/blog is on top so ~/code/acme
 * never passes over it on its way down.
 */
const Y = { home: "var(--acme-home)", ruled: "var(--acme-ruled)", blog: "var(--blog-y)" };

export default function AccountsPicture({ lang, chosen, run, drawn, armed, reduced, say }: PictureProps) {
  const t = ACCOUNTS_TEXT[lang];
  const beats = BEATS[chosen] ?? BEATS[0]!;
  const phase = usePhase(`${chosen}-${run}`, beats, run > 0, reduced);
  const p = run > 0 ? phase : 0;

  // The line under the picture: the command as typed and what turno printed.
  let cmd = `turno profile assign ${ACME} work`;
  let result: string | undefined;
  if (chosen === 0) {
    if (p >= 1) result = `${ACME} -> work`;
  } else {
    cmd = `cd ${p >= 2 ? API : BLOG} && turno auto`;
    if (p === 1) result = "turno: account personal (folder without a rule)";
    if (p >= 3) result = `turno: account work (project ${ACME})`;
  }
  useEffect(() => {
    if (run > 0) say({ prompt: "$", cmd, result });
  }, [run, cmd, result, say]);

  // The rule exists from the moment assign prints, and before every run of turno auto.
  const ruled = chosen === 1 || p >= 1;
  // ~/code/acme leaves for work when the rule is written, and changes account at the hairline.
  const moved = chosen === 1 || p >= 2;
  const crossed = chosen === 1 || p >= 3;
  const travel = chosen === 0 && (p === 2 || p === 3);
  const blogOpen = chosen === 1 && p >= 1;
  const apiOpen = chosen === 1 && p >= 3;

  return (
    <Stage
      active={[blogOpen, apiOpen]}
      sub={[t.default, t.login]}
      bar={{
        name: "config.toml",
        text: 'default = "personal"',
        end: ruled ? `[[projects]] path = "${ACME}" profile = "work"` : undefined,
      }}
      cut={run > 0 && p === 0}
      drawn={drawn}
      armed={armed}
      reduced={reduced}
    >
      <Folder
        lane={moved ? 1 : 0}
        y={moved ? Y.ruled : Y.home}
        tone={crossed ? "work" : "personal"}
        travel={travel}
        name={`${ACME}/`}
        child="api/"
        open={apiOpen ? "child" : null}
        mark={t.open}
        order={0}
      />
      <Folder lane={0} y={Y.blog} tone="personal" name={`${BLOG}/`} open={blogOpen ? "self" : null} mark={t.open} order={1} />
    </Stage>
  );
}

/**
 * A folder, drawn the way the stage draws an artifact: its outline is the account it opens as.
 * A subfolder sits inside its parent's outline, so it goes wherever the parent's rule sends it.
 */
function Folder({
  lane,
  y,
  tone,
  travel = false,
  name,
  child,
  open,
  mark,
  order,
}: {
  lane: Lane;
  y: string;
  tone: Tone;
  travel?: boolean;
  name: string;
  child?: string;
  /** Where the agent was opened: in this folder, in its subfolder, or nowhere yet. */
  open: "self" | "child" | null;
  mark: string;
  /** Its place in the order the picture draws itself in. */
  order: number;
}) {
  return (
    <div className={s.mover} style={{ ...place(lane, y), "--tone": `var(--tone-${tone})`, "--i": order } as CSSProperties} data-travel={travel || undefined}>
      <div className={s.folder}>
        <div className={s.row}>
          <span aria-hidden className={s.icon} />
          <span className={s.name}>{name}</span>
          {open === "self" ? <Open mark={mark} /> : null}
        </div>
        {child ? (
          <div className={s.row} data-child>
            <span aria-hidden className={s.branch}>
              └─
            </span>
            <span className={s.name}>{child}</span>
            {open === "child" ? <Open mark={mark} /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The agent turno auto opened here, with the agent's mark from the session card. */
function Open({ mark }: { mark: string }) {
  return (
    <span className={s.open}>
      <span aria-hidden>●</span> {mark}
    </span>
  );
}
