"use client";

import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { type Lang, landingCopy } from "../copy";
import type { Tone } from "../kit";
import { BEAT } from "../story";
import { type ChapterCommand, DRAW_BEATS, type PictureProps } from "./section";
import { TRAVEL, usePhase } from "./stage";
import s from "./start.module.css";

/*
 * Chapter 8: your HOME, and the three ways turno shows you something before it touches it.
 * `turno demo` builds a throwaway HOME under the temp folder with two profiles and a gateway on
 * 127.0.0.1, never reads or writes yours, never signs in, and removes it all on exit
 * (cli/commands/demo.ts, docs/get-started/try-it.mdx). `turno init` prints the whole change,
 * asks "Write all of this?", and writes it through one journal; `turno undo <stamp>` puts it
 * back and prints `undo <stamp>  init` (cli/commands/init.ts, cli/commands/undo.ts). `turno
 * uninstall --dry-run` lists what would go and what stays: profile folders hold logins and are
 * never deleted, and the backups under ~/.local/state/turno stay (cli/commands/uninstall.ts).
 */

const DEMO_HOME = "/private/tmp/turno-demo-Xk3f9a";
const STAMP = "20261116-091204";

export const START_TEXT = {
  en: {
    figure: "Your HOME beside what turno shows you first: a throwaway HOME, a change before it is written, a list before anything is removed. Choose a command to run it here.",
    home: "your HOME",
    state: {
      untouched: "not read, not changed",
      planned: "nothing written yet",
      written: "one change, undoable",
      undone: "as before",
      dry: "dry run: nothing removed",
    },
    /* What turno does, said after its name in the head of its column. */
    does: {
      demo: "demo in a throwaway HOME",
      plan: "shows the change first",
      undone: "puts it back as one change",
      dry: "lists it all before removing",
    },
    demo: { work: "~/code/acme", personal: "every other folder", gateway: "docs, issues", exit: "exit removes all of it" },
    undone: "undone",
    wouldRemove: "would remove",
    stays: "stays",
    bar: {
      demo: "the demo's gateway, a token per profile: nothing leaves your machine",
      backups: "a copy of each file, kept before turno writes it",
      state: "stays, so turno undo can still put it all back",
    },
  },
  es: {
    figure: "Tu HOME junto a lo que turno te muestra primero: un HOME desechable, un cambio antes de escribirse, una lista antes de quitar algo. Elige un comando para correrlo aquí.",
    home: "tu HOME",
    state: {
      untouched: "ni se lee ni se cambia",
      planned: "nada escrito todavía",
      written: "un solo cambio, reversible",
      undone: "como estaba",
      dry: "simulación: no se quita nada",
    },
    does: {
      demo: "demo en un HOME desechable",
      plan: "muestra el cambio primero",
      undone: "lo revierte de una vez",
      dry: "lista todo antes de quitar",
    },
    demo: { work: "~/code/acme", personal: "las demás carpetas", gateway: "docs, issues", exit: "exit lo borra todo" },
    undone: "revertido",
    wouldRemove: "quitaría",
    stays: "se queda",
    bar: {
      demo: "el gateway de la demo, un token por perfil: nada sale de tu máquina",
      backups: "una copia de cada archivo, guardada antes de que turno escriba",
      state: "se queda, así turno undo todavía puede revertirlo todo",
    },
  },
};

/** The section's commands from copy.ts: all three are typed in a shell. */
export function startCommands(lang: Lang): ChapterCommand[] {
  return landingCopy(lang).sections.start.commands.map((command) => ({ ...command, prompt: "$" }));
}

const HALF = TRAVEL / 2;
const BEATS: Record<number, number[]> = {
  // type, the throwaway HOME and its first entry, the second, the third, the promise
  0: [4, 2, 1, 1, 1],
  // type init, the plan and its question, travel in to the hairline, on into your HOME, written,
  // type undo, back out to the hairline, on to where it came from, undone
  1: [4, 3, HALF, HALF + 1, 3, 4, HALF, HALF + 1, 1],
  // type, the list and its first entry, the second, what stays
  2: [4, 2, 1, 1],
};

type Lane = 0 | 1;
type BoxState = "plan" | "written" | "undone";

export default function StartPicture({ lang, chosen, run, drawn, armed, reduced, say }: PictureProps) {
  const t = START_TEXT[lang];
  const beats = BEATS[chosen] ?? BEATS[0]!;
  const phase = usePhase(`${chosen}-${run}`, beats, run > 0, reduced);
  const p = run > 0 ? phase : 0;
  const drawing = useDrawing(drawn, reduced);

  /* The line under the picture: what was typed, and what turno printed. */
  let cmd = "npx turno-cli demo";
  let result: string | undefined;
  if (chosen === 0) {
    if (p >= 1) result = p >= 4 ? "Nothing here reads or changes your own HOME, and nothing signs in." : `turno demo  a throwaway HOME at ${DEMO_HOME}`;
  } else if (chosen === 1) {
    cmd = p >= 5 ? `turno undo ${STAMP}` : "turno init";
    if (p >= 1 && p < 3) result = "Write all of this? [y/N] y";
    if (p >= 3 && p < 5) result = `Undo all of it with: turno undo ${STAMP}`;
    if (p >= 8) result = `undo ${STAMP}  init`;
  } else {
    cmd = "turno uninstall --dry-run";
    if (p >= 1) result = p >= 3 ? "~/.claude-work (profile work: its login and history) stays" : "turno uninstall would remove:";
  }
  useEffect(() => {
    if (run > 0) say({ prompt: "$", cmd, result });
  }, [run, cmd, result, say]);

  /* What each command draws. */
  let state = "";
  let does = "";
  let bar: { name: string; text: string } = { name: "127.0.0.1", text: t.bar.demo };
  let preview: ReactNode = null;
  let change: { lane: Lane; box: BoxState; travel: boolean } | null = null;
  let stays = false;

  if (chosen === 0) {
    if (p >= 1) {
      state = t.state.untouched;
      does = t.does.demo;
    }
    if (p >= 1) {
      preview = (
        <Box lane={1} label={DEMO_HOME} state="plan" foot={p >= 4 ? t.demo.exit : undefined}>
          <File name=".claude-work/" tone="work" note={t.demo.work} />
          {p >= 2 ? <File name=".claude-personal/" tone="personal" note={t.demo.personal} /> : null}
          {p >= 3 ? <File name="mcpd" tone="keep" note={t.demo.gateway} /> : null}
        </Box>
      );
    }
  } else if (chosen === 1) {
    does = p >= 7 ? t.does.undone : p >= 1 ? t.does.plan : "";
    bar = { name: "~/.local/state/turno/backups", text: t.bar.backups };
    state = p >= 7 ? t.state.undone : p >= 3 ? t.state.written : p >= 1 ? t.state.planned : "";
    if (p >= 1) {
      // In at 2, across the hairline at 3; out at 6, across at 7.
      const inside = p >= 2 && p < 6;
      const box: BoxState = p >= 7 ? "undone" : p >= 3 ? "written" : "plan";
      change = { lane: inside ? 0 : 1, box, travel: p === 2 || p === 3 || p === 6 || p === 7 };
    }
  } else {
    if (p >= 1) does = t.does.dry;
    bar = { name: "~/.local/state/turno", text: t.bar.state };
    change = { lane: 0, box: "written", travel: false };
    if (p >= 3) state = t.state.dry;
    stays = p >= 3;
    if (p >= 1) {
      preview = (
        <Box lane={1} label={t.wouldRemove} state="plan">
          <File name=".config/turno/" sign="−" />
          {p >= 2 ? <File name=".local/bin/claude-work" sign="−" /> : null}
        </Box>
      );
    }
  }

  const cut = run > 0 && p === 0;

  return (
    <div className={s.wrap}>
      <div className={s.stage} data-cut={cut || undefined} data-wait={(armed && !drawn) || undefined} data-drawing={drawing || undefined}>
        <div className={s.head} data-lane={0}>
          <span className={s.place}>{t.home}</span>
          <span className={s.sub}>{state}</span>
        </div>
        <div className={s.head} data-lane={1}>
          <span className={s.place} data-turno>
            turno
          </span>
          <span className={s.sub} data-turno>
            {does}
          </span>
        </div>
        <span aria-hidden className={s.divider} />
        <div className={s.layer}>
          <ul className={s.home}>
            <File name=".claude/" sign="" />
            <File name="code/acme/" sign="" />
            <File name=".zshrc" sign="" />
          </ul>
          {change ? (
            <Box
              key="change"
              lane={change.lane}
              y={change.lane === 0 ? "var(--below)" : 0}
              label={change.box === "plan" ? "turno init" : change.box === "written" ? STAMP : `${STAMP} · ${t.undone}`}
              state={change.box}
              travel={change.travel}
            >
              <File name=".config/turno/" sign="+" />
              <File name=".claude-work/" sign="+" tone="work" note={stays ? t.stays : undefined} strong />
              <File name=".local/bin/claude-work" sign="+" />
            </Box>
          ) : null}
          {preview}
        </div>
        <div className={s.bar}>
          <div aria-hidden className={s.barLine} />
          <p className={s.barCaption}>
            <span className={s.barName}>{bar.name}</span>
            <span className={s.barText}>{bar.text}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Something turno shows beside your HOME, or a change inside it: dashed and blue while it is only
 * shown, solid once it is written into your HOME, quiet once it is undone.
 */
function Box({
  lane,
  y = 0,
  label,
  state,
  travel = false,
  foot,
  children,
}: {
  lane: Lane;
  y?: number | string;
  label: string;
  state: BoxState;
  travel?: boolean;
  foot?: string;
  children: ReactNode;
}) {
  return (
    <div className={s.mover} style={{ "--lane": lane, "--y": typeof y === "number" ? `${y}px` : y } as CSSProperties} data-travel={travel || undefined}>
      <div className={s.box} data-state={state}>
        <span className={s.boxLabel}>{label}</span>
        <ul className={s.files}>{children}</ul>
        {foot ? <p className={s.foot}>{foot}</p> : null}
      </div>
    </div>
  );
}

/**
 * One entry of a HOME: a sign and a note say what happens to it, so color is never alone. An
 * empty sign keeps the column, so names line up with signed entries under them.
 */
function File({ name, sign, tone, note, strong = false }: { name: string; sign?: string; tone?: Tone; note?: string; strong?: boolean }) {
  return (
    <li className={s.file} style={tone ? ({ "--tick": `var(--tone-${tone})` } as CSSProperties) : undefined}>
      {sign === undefined ? null : (
        <span aria-hidden className={s.sign}>
          {sign}
        </span>
      )}
      <span className={s.name}>{name}</span>
      {note ? (
        <span className={s.note} data-strong={strong || undefined}>
          {note}
        </span>
      ) : null}
    </li>
  );
}

/** True for the beats the picture spends drawing itself, as the stage counts them. */
function useDrawing(drawn: boolean, reduced: boolean): boolean {
  const [drawing, setDrawing] = useState(false);
  useEffect(() => {
    if (!drawn || reduced) return;
    setDrawing(true);
    const timer = setTimeout(() => setDrawing(false), (DRAW_BEATS + 2) * BEAT);
    return () => clearTimeout(timer);
  }, [drawn, reduced]);
  return drawing;
}
