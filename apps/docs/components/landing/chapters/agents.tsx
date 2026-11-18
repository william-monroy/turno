"use client";

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { type Lang, landingCopy } from "../copy";
import { AccountPill } from "../kit";
import a from "./agents.module.css";
import { SESSION, WHERE } from "./context";
import { Below, Frame, useTravel } from "./logins";
import l from "./logins.module.css";
import type { ChapterCommand, PictureProps } from "./section";
import { place, Session, Stage, TRAVEL, usePhase } from "./stage";

/*
 * Chapter 7: the lanes are the two Claude Code accounts, and other agents get profiles under the
 * same rules. A turno profile is one account of one agent, a folder and a launcher
 * (concepts/profiles.mdx): personal runs the page's conversation through claude-personal, work
 * has claude-work. `turno profile add cx --agent codex` writes [profiles.cx] to config.toml and
 * sets up ~/.codex-cx with the codex-cx launcher (cli/commands/profile.ts, setup.ts): an account
 * of another agent, so it hangs under the bar in the third tone, the way the browser chapter
 * brings in its third identity. An agent turno does not manage gets gateway entries that name a
 * profile (agents/snippets.ts, X-Turno-Profile), so it hangs there too, with no tone of its own.
 * `turno ui install` sets the status line in the shared ~/.claude/settings.json
 * (cli/commands/ui.ts, ui/settings.ts), so every Claude Code profile shows it; its parts and
 * meanings are those of components/diagrams/status-line.tsx.
 */

/** Agents turno prints gateway entries for (agents/snippets.ts SNIPPET_AGENTS). */
const UNMANAGED = ["opencode", "gemini", "goose", "crush", "droid", "kiro"];

/*
 * The status line in its Unicode look (statusline/render.ts), as one line: the short form of a
 * part where a narrow terminal prints one (meters and reset times dropped, a 5 cell context bar),
 * the full form of the two parts a narrow terminal leaves out. Focus or hover shows the full form.
 */
const STATUS: { short: string; full?: string }[] = [
  { short: "◉ personal · Max" },
  { short: "⧗ 41%", full: "⧗ ▰▰▰▱▱▱▱▱ 41%  ↺ 2h01m" },
  { short: "▦ 67%", full: "▦ ▰▰▰▰▰▱▱▱ 67%  ↺ 2d7h" },
  { short: "◔ [#----] 23%", full: "◔ [##--------] 23%  230k/1M" },
  { short: "▮ ~38 turns" },
  { short: "▣ acme  ⎇ main", full: "▣ acme │ ⎇ main" },
  { short: "± +128 −14" },
  { short: "◈ Opus 5.5 ✦ high" },
  { short: "$4.82", full: "$4.82 (sub $1)" },
];
/** The account row ends after the fifth part, the session row starts with the sixth. */
const ROW_ONE = 5;

/* The tool's own lines (cli/commands/profile.ts, setup.ts, mcp.ts, ui.ts). */
const OUT = {
  added: "+ [profiles.cx] in ~/.config/turno/config.toml",
  linked: "▸ cx (Codex CLI) → ~/.codex-cx: shares 4 items with ~/.codex (-v lists them)",
  entries: "# opencode.json (project) or ~/.config/opencode/opencode.json",
  status: "statusline: ~/.claude/settings.json now runs `turno statusline` every 30 s",
};

export const AGENTS_TEXT = {
  en: {
    figure: "Two Claude Code accounts in their lanes, and under the setup they share, a profile of another agent. Choose a command to run it here.",
    sub: "Claude Code",
    codex: "Codex CLI",
    opencode: "not managed by turno",
    bar: {
      rest: "the same profiles and folder rules for Claude Code, Codex CLI, Copilot CLI and Cursor CLI",
      profile: '[profiles.cx] agent = "codex"',
      gateway: "the same gateway, for agents turno does not manage too",
      settings: "settings.json, shared by every Claude Code profile: work shows it too",
    },
    none: "no profile of another agent yet",
    hint: "hover over a part or focus it to read what it shows",
    parts: [
      ["Profile and plan", "The pill. Its color comes from the profile's color in config.toml."],
      ["5 h usage", "The account's 5 hour window and the time until it resets."],
      ["Weekly usage", "The account's weekly window and the time until it resets."],
      ["Context", "Context used, as a bar and as tokens."],
      ["Turns left", "Turns left in the 5 h window, estimated from recent turns."],
      ["Project and branch", "The project (and worktree) and its git branch, read without running git."],
      ["Lines changed", "Lines added and removed."],
      ["Model and effort", "The model of the conversation and its effort."],
      ["Cost", "The API-equivalent cost of the conversation, subagents included."],
    ] as [string, string][],
    line: "status line",
  },
  es: {
    figure: "Dos cuentas de Claude Code en sus carriles y, bajo la configuración que comparten, un perfil de otro agente. Elige un comando para correrlo aquí.",
    sub: "Claude Code",
    codex: "Codex CLI",
    opencode: "turno no lo administra",
    bar: {
      rest: "los mismos perfiles y reglas de carpeta para Claude Code, Codex CLI, Copilot CLI y Cursor CLI",
      profile: '[profiles.cx] agent = "codex"',
      gateway: "el mismo gateway, también para agentes que turno no administra",
      settings: "settings.json, lo comparten todos los perfiles de Claude Code: work también la muestra",
    },
    none: "todavía no hay perfiles de otro agente",
    hint: "pasa el cursor sobre una parte o enfócala para leer qué muestra",
    parts: [
      ["Perfil y plan", "La píldora. Su color es el color del perfil en config.toml."],
      ["Uso de 5 h", "La ventana de 5 horas de la cuenta y lo que falta para que se reinicie."],
      ["Uso semanal", "La ventana semanal de la cuenta y lo que falta para que se reinicie."],
      ["Contexto", "El contexto usado, como barra y en tokens."],
      ["Turnos restantes", "Los turnos que quedan en la ventana de 5 h, estimados con los turnos recientes."],
      ["Proyecto y rama", "El proyecto (y el worktree) y su rama de git, leídos sin correr git."],
      ["Líneas cambiadas", "Líneas agregadas y eliminadas."],
      ["Modelo y esfuerzo", "El modelo de la conversación y su esfuerzo."],
      ["Costo", "El costo equivalente en la API de la conversación, con subagentes incluidos."],
    ] as [string, string][],
    line: "status line",
  },
};

export function agentsCommands(lang: Lang): ChapterCommand[] {
  return landingCopy(lang).sections.agents.commands.map((command) => ({ ...command, prompt: "$" }));
}

/* The commands as typed in the picture: the second one names a real agent and profile. */
const TYPED = ["turno profile add cx --agent codex", "turno mcp config --agent opencode --profile work", "turno ui install"];

const BEATS: Record<number, number[]> = {
  // type, config.toml gets [profiles.cx] (on the bar), it goes down under the bar, set up
  0: [4, 3, TRAVEL, 1],
  // type, opencode under the bar, its entries printed
  1: [4, 3, 1],
  // type, the parts one per beat, the line
  2: [4, STATUS.length, 1],
};

type Other = "none" | "cx" | "opencode";

export default function AgentsPicture({ lang, chosen, run, drawn, armed, reduced, say }: PictureProps) {
  const t = AGENTS_TEXT[lang];
  const beats = BEATS[chosen] ?? BEATS[0]!;
  const phase = usePhase(`${chosen}-${run}`, beats, run > 0, reduced);
  const p = run > 0 ? phase : 0;

  /* What each command draws. The commands read in order: each starts where the last one rests. */
  let other: Other = chosen >= 1 && run > 0 ? "cx" : "none";
  let onBar = false;
  let dropping = false;
  let landed = true;
  let wired = false;
  let status: "hidden" | "fill" | "shown" = "hidden";
  let barName = "~/.config/turno";
  let barText: ReactNode = t.bar.rest;
  let barEnd: ReactNode;
  let result: string | undefined;

  if (run > 0 && chosen === 0) {
    if (p >= 1) {
      barText = t.bar.profile;
      result = OUT.added;
    }
    // Written to config.toml, it stands on the bar; then it goes down to its place under it.
    onBar = p === 1;
    if (p >= 2) other = "cx";
    dropping = p === 2 && !reduced;
    landed = p >= 3 || reduced;
    if (p >= 3) result = OUT.linked;
  } else if (run > 0 && chosen === 1) {
    other = p >= 1 ? "opencode" : "cx";
    barName = "mcpd";
    barText = t.bar.gateway;
    barEnd = (
      <span className={a.unmanaged}>
        {UNMANAGED.map((name, index) => (
          <span key={name} data-on={(p >= 1 && index === 0) || undefined}>
            {name}
          </span>
        ))}
      </span>
    );
    wired = true;
    if (p >= 2) result = OUT.entries;
  } else if (run > 0 && chosen === 2) {
    barName = "~/.claude";
    barText = t.bar.settings;
    status = p >= 2 ? "shown" : p === 1 ? "fill" : "hidden";
    if (p >= 2) result = OUT.status;
  }

  useEffect(() => {
    if (run > 0) say({ prompt: "$", cmd: TYPED[chosen] ?? "", result });
  }, [run, chosen, result, say]);

  /* The one thing that travels: cx's pill, from config.toml on the bar down to its card. */
  const frame = useRef<HTMLDivElement>(null);
  const launch = useRef<HTMLSpanElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const traveler = useRef<HTMLDivElement>(null);
  useTravel({ on: dropping, frame, from: launch, to: pill, node: traveler, beats: TRAVEL, align: "start" });

  return (
    <Frame frameRef={frame} drawn={drawn} armed={armed} reduced={reduced}>
      <Stage
        active={[true, false]}
        sub={[t.sub, t.sub]}
        bar={{ name: barName, text: barText, end: barEnd }}
        cut={run > 0 && p === 0}
        drawn={drawn}
        armed={armed}
        reduced={reduced}
      >
        {wired ? (
          <>
            <span aria-hidden className={a.wire} style={{ "--lane": 0 } as CSSProperties} data-lane={0} />
            <span aria-hidden className={a.wire} style={{ "--lane": 1 } as CSSProperties} data-lane={1} />
          </>
        ) : null}
        <Session id={SESSION} where={WHERE} turns={[]} lane={0} compact>
          <span className={a.launcher}>claude-personal</span>
        </Session>
        <div className={a.at} style={place(1)} data-lane={1}>
          <div className={a.profile}>
            <span className={a.head}>
              <span className={a.name}>work</span>
              <span className={a.where}>~/.claude-work</span>
            </span>
            <span className={a.launcher}>claude-work</span>
          </div>
        </div>
        {chosen === 0 && run > 0 ? (
          <span ref={launch} aria-hidden className={l.onBar} style={{ visibility: onBar ? "visible" : "hidden" }}>
            <AccountPill tone="third">cx</AccountPill>
          </span>
        ) : null}
        {status !== "hidden" ? <StatusLine parts={t.parts} hint={t.hint} label={t.line} fill={status === "fill"} /> : null}
      </Stage>

      {/* Under the bar, one agent that is not Claude Code; its place keeps the picture's height. */}
      <Below>
        <div className={a.other} data-drop={dropping || undefined}>
          {other === "none" ? <span className={a.none}>{t.none}</span> : null}
          {other === "cx" ? (
            <div className={a.card} style={{ "--tone": "var(--tone-third)" } as CSSProperties}>
              <span className={a.head}>
                <span ref={pill} style={{ visibility: landed ? "visible" : "hidden" }}>
                  <AccountPill tone="third">cx</AccountPill>
                </span>
                <span className={a.sub}>{t.codex}</span>
              </span>
              <span className={a.foot}>
                <span>codex-cx</span>
                <span className={a.where}>~/.codex-cx</span>
              </span>
            </div>
          ) : null}
          {other === "opencode" ? (
            <div className={a.card} data-unmanaged>
              <span className={a.head}>
                <span className={a.name}>opencode</span>
                <span className={a.where}>{t.opencode}</span>
              </span>
              <span className={a.foot}>
                <span>X-Turno-Profile: work</span>
                <span className={a.where}>opencode.json</span>
              </span>
            </div>
          ) : null}
        </div>
      </Below>

      <div ref={traveler} aria-hidden className={l.traveler}>
        <AccountPill tone="third">cx</AccountPill>
      </div>
    </Frame>
  );
}

/**
 * The status line under the session, one line of nine parts. A part says what it is only when it
 * is hovered or focused, on the line under it, with its full form.
 */
function StatusLine({ parts, hint, label, fill }: { parts: [string, string][]; hint: string; label: string; fill: boolean }) {
  const [at, setAt] = useState<number | null>(null);
  const part = at === null ? null : STATUS[at];
  const meaning = at === null ? null : parts[at];
  const token = (index: number) => {
    const { short, full } = STATUS[index]!;
    const [name, what] = parts[index]!;
    return (
      <span
        key={short}
        role="img"
        tabIndex={0}
        aria-label={`${full ?? short}. ${name}. ${what}`}
        className={a.part}
        data-pill={index === 0 || undefined}
        data-at={at === index || undefined}
        style={{ "--i": index } as CSSProperties}
        onMouseEnter={() => setAt(index)}
        onMouseLeave={() => setAt((was) => (was === index ? null : was))}
        onFocus={() => setAt(index)}
        onBlur={() => setAt((was) => (was === index ? null : was))}
      >
        {short}
      </span>
    );
  };
  return (
    <div className={`${a.mover} ${a.status}`} data-fill={fill || undefined} role="group" aria-label={label}>
      <div className={a.line}>
        <span className={a.row}>{STATUS.slice(0, ROW_ONE).map((_, index) => token(index))}</span>
        <span className={a.row}>{STATUS.slice(ROW_ONE).map((_, index) => token(index + ROW_ONE))}</span>
      </div>
      {/* Each part already carries its meaning for a screen reader: this line is for the eye. */}
      <p aria-hidden className={a.explain}>
        {part && meaning ? (
          <>
            <span className={a.full}>{part.full ?? part.short}</span>
            <span className={a.partName}>{meaning[0]}.</span> {meaning[1]}
          </>
        ) : (
          <span className={a.hint}>{hint}</span>
        )}
      </p>
    </div>
  );
}
