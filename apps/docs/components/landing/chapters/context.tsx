"use client";

import { type ReactNode, useEffect } from "react";
import { landingCopy } from "../copy";
import type { ChapterCommand, PictureProps } from "./section";
import { Place, Session, Stage, TRAVEL, type Turn, usePhase } from "./stage";

/*
 * Chapter 1: a Claude Code session moving between profiles, as docs/concepts/profiles.mdx
 * describes it. Every profile links the hub's conversations, skills, commands, hooks, plugins
 * and settings (agents/claude.ts, SHARED_DIRS) and keeps only its own login. `turno session
 * handoff` prints the command that resumes the session elsewhere (cli/commands/handoff.ts); with
 * --fork the command ends in --fork-session, the copy gets a new id and the original goes on.
 */

/** The conversation of the whole page: the same id in every chapter. */
export const SESSION = "7f3c9a2e";
export const FORKED = "c41b07d2";
export const WHERE = "~/code/acme";

export const CONTEXT_TEXT = {
  en: {
    figure: "Two accounts, one conversation. Choose a command to run it here.",
    login: "its own login",
    hub: "shared by every profile: conversations, skills, commands, hooks, plugins, settings",
    session: "session",
    forkOf: "fork of",
    landing: `--resume ${SESSION} lands here`,
    turns: {
      first: "add rate limiting to the api",
      firstDone: "edited src/limits.ts  +24 −3",
      next: "now cover it with tests",
      nextDone: "wrote test/limits.test.ts  +41",
      side: "update the changelog",
    },
    result: {
      resume: "the same session goes on as work, history and all",
      fork: `forked: personal keeps ${SESSION}, work goes on in ${FORKED}`,
    },
  },
  es: {
    figure: "Dos cuentas, una conversación. Elige un comando para correrlo aquí.",
    login: "su propio inicio de sesión",
    hub: "lo comparten todos los perfiles: conversaciones, skills, comandos, hooks, plugins, ajustes",
    session: "sesión",
    forkOf: "copia de",
    landing: `--resume ${SESSION} llega aquí`,
    turns: {
      first: "agrega límite de peticiones a la api",
      firstDone: "edited src/limits.ts  +24 −3",
      next: "ahora cúbrelo con pruebas",
      nextDone: "wrote test/limits.test.ts  +41",
      side: "actualiza el changelog",
    },
    result: {
      resume: "la misma sesión sigue como work, con todo su historial",
      fork: `bifurcada: personal conserva ${SESSION} y work sigue en ${FORKED}`,
    },
  },
};

/** The section's commands from copy.ts, with what stands before each. */
export function contextCommands(lang: "en" | "es"): ChapterCommand[] {
  return landingCopy(lang).sections.context.commands.map((command) => ({ ...command, prompt: "$" }));
}

const PRINTED = `cd ${WHERE} && turno work --resume ${SESSION}…`;

/*
 * The phases of each command and how many beats each holds. 0 is the cut to the first state while
 * the command types; the travel takes TRAVEL beats and the accounts swap when the card crosses
 * the hairline, at half of it.
 */
const HALF = TRAVEL / 2;
const BEATS: Record<number, number[]> = {
  0: [4, HALF, HALF + 1, 3, 1],
  1: [4, 1],
  2: [4, 3, 2, HALF, HALF + 1, 3, 1],
};

export default function ContextPicture({ lang, chosen, run, drawn, armed, reduced, say }: PictureProps) {
  const t = CONTEXT_TEXT[lang];
  const beats = BEATS[chosen] ?? BEATS[0]!;
  const phase = usePhase(`${chosen}-${run}`, beats, run > 0, reduced);
  const p = run > 0 ? phase : 0;

  const history: Turn[] = [
    { who: "user", text: t.turns.first, tone: "personal" },
    { who: "agent", text: t.turns.firstDone, tone: "personal" },
  ];
  const onWork: Turn[] = [
    { who: "user", text: t.turns.next, tone: "work" },
    { who: "agent", text: t.turns.nextDone, tone: "work" },
  ];

  const command = contextCommands(lang)[chosen]!;
  const typed = chosen === 0 ? `turno work --resume ${SESSION}…` : command.run;

  // What the line under the picture says, phase by phase.
  let result: string | undefined;
  if (chosen === 0 && p >= 4) result = t.result.resume;
  if (chosen === 1 && p >= 1) result = PRINTED;
  if (chosen === 2 && p >= 1) result = p >= 6 ? t.result.fork : `${PRINTED} --fork-session`;

  useEffect(() => {
    if (run > 0) say({ prompt: "$", cmd: typed, result });
  }, [run, typed, result, say]);

  let active: [boolean, boolean] = [true, false];
  let body: ReactNode;

  if (chosen === 0) {
    // Continue: the same card travels, and the account under it changes at the hairline.
    const moved = p >= 1;
    active = p >= 2 ? [false, true] : [true, false];
    const turns = [...history, ...(p >= 3 ? onWork.slice(0, 1) : []), ...(p >= 4 ? onWork.slice(1) : [])];
    body = <Session id={`${t.session} ${SESSION}`} where={WHERE} turns={turns} lane={moved ? 1 : 0} travel={p >= 1 && p <= 2} />;
  } else if (chosen === 1) {
    // Handoff: nothing moves yet. The command it printed says where the session continues.
    body = (
      <>
        {p >= 1 ? <Place lane={1} label={t.landing} /> : null}
        <Session id={`${t.session} ${SESSION}`} where={WHERE} turns={history} lane={0} />
      </>
    );
  } else {
    // Fork: a copy lifts off the session and travels; both go on, each as its own account.
    const lifted = p >= 2;
    const flying = p >= 3;
    const landed = p >= 5;
    active = p >= 4 ? [true, true] : [true, false];
    const forkTurns = [...history, ...(p >= 5 ? onWork.slice(0, 1) : []), ...(p >= 6 ? onWork.slice(1) : [])];
    const originTurns = [...history, ...(p >= 6 ? [{ who: "user" as const, text: t.turns.side, tone: "personal" as const }] : [])];
    body = (
      <>
        <Session id={`${t.session} ${SESSION}`} where={WHERE} turns={originTurns} lane={0} />
        {lifted ? (
          <Session
            id={`${t.session} ${landed ? FORKED : SESSION}`}
            where={landed ? `${t.forkOf} ${SESSION}` : WHERE}
            turns={forkTurns}
            lane={flying ? 1 : 0}
            peel={!flying}
            travel={flying && !landed}
          />
        ) : null}
      </>
    );
  }

  return (
    <Stage
      active={active}
      sub={[t.login, t.login]}
      bar={{ name: "~/.claude", text: t.hub }}
      cut={run > 0 && p === 0}
      drawn={drawn}
      armed={armed}
      reduced={reduced}
    >
      {body}
    </Stage>
  );
}
