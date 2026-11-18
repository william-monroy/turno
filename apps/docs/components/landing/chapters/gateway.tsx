"use client";

import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { type Lang, landingCopy } from "../copy";
import { BEAT } from "../story";
import { SESSION } from "./context";
import g from "./gateway.module.css";
import type { ChapterCommand, PictureProps } from "./section";
import { DOT, Stage, TRAVEL, usePhase } from "./stage";

/*
 * Chapter 6: the benchmark on the page's own picture. Eight sessions sit in the account lanes and
 * the blue bar is mcpd itself, with the six servers of bench/mcp-ram.mjs on it, each once. Every
 * figure is a cell of BENCHMARKS.md (Apple M3, 16 GB, 2026-11-16, 8 sessions), shown with its
 * unit and never in between: direct 3,163 MiB and 56 processes, turno with every server running
 * 847 MiB and 8, turno idle 103 MiB and 1, and "73% less while every server runs and 97% less
 * while they are idle". The bench counts processes, not servers (some servers run a child), so
 * the copies are drawn per server and the count is only ever written.
 *
 * What each command shows is what it reports (cli/commands/mcp-observe.ts): `top` the running
 * servers and mcpd's memory with them, `savings` that memory against the same sessions each
 * starting its own copies, `log` one line per tool call mcpd relays (docs/mcp.md), never its
 * arguments. A call starts its server on the first real call (concepts/gateway.mdx).
 *
 * The line under the picture does not imitate `top` or `savings`: their real lines need values
 * the benchmark does not have (mcpd's pid, uptime and own memory) or derive one (the amount
 * saved), and they print MiB as "MB". So it says the benchmark's cells, as the benchmark's.
 */

/** BENCHMARKS.md, 8 sessions: [MiB, processes]. */
const BENCH = { direct: [3163, 56], running: [847, 8], idle: [103, 1] } as const;
/** BENCHMARKS.md: "73% less memory while every server runs and 97% less while they are idle". */
const LESS = { running: 73, idle: 97 } as const;
/** bench/mcp-ram.mjs, SERVERS, by the names it gives them. */
const SERVERS = ["playwright", "devtools", "filesystem", "memory", "thinking", "context7"] as const;
/** The server the logged call reaches: a Playwright MCP tool. */
const CALLED = 0;
const PER_LANE = 4;
/** The page's conversation is the first session of the personal lane: its line lands on the called server. */
const OURS = 0;

const mib = (n: number) => n.toLocaleString("en-US");

export const GATEWAY_TEXT = {
  en: {
    figure: "Eight sessions on two accounts above one gateway, with six MCP servers on it, each running once. Choose a command to run it here.",
    sessions: `${PER_LANE} sessions`,
    processes: (n: number) => `${n} ${n === 1 ? "process" : "processes"}`,
    less: (n: number) => `${n}% less`,
    lines: (n: number) => `calls.jsonl · ${n} ${n === 1 ? "line" : "lines"}`,
    bar: {
      rest: "one local process that every session reaches",
      top: "each server once, shared by every session",
      direct: "without it, every session starts its own copy of every server",
      idle: "no server runs until a tool is called",
      woke: "it started on the first real call",
      log: "one line per tool call it relays",
    },
    // Not what the tool prints on your machine: the benchmark's cells, said as the benchmark's.
    result: {
      top: `in the benchmark, 8 sessions with each of the 6 servers running once: ${mib(BENCH.running[0])} MiB, ${BENCH.running[1]} processes`,
      direct: `in the benchmark, the same 8 sessions without the gateway: ${mib(BENCH.direct[0])} MiB, ${BENCH.direct[1]} processes`,
      running: `in the benchmark: ${LESS.running}% less while every server runs`,
      both: `in the benchmark: ${LESS.running}% less while every server runs, ${LESS.idle}% less while they are idle`,
    },
  },
  es: {
    figure: "Ocho sesiones de dos cuentas sobre un solo gateway, con seis servidores MCP encima, cada uno corriendo una vez. Elige un comando para correrlo aquí.",
    sessions: `${PER_LANE} sesiones`,
    processes: (n: number) => `${n} ${n === 1 ? "proceso" : "procesos"}`,
    less: (n: number) => `${n}% menos`,
    lines: (n: number) => `calls.jsonl · ${n} ${n === 1 ? "línea" : "líneas"}`,
    bar: {
      rest: "un solo proceso local al que llega cada sesión",
      top: "cada servidor una vez, compartido por todas las sesiones",
      direct: "sin él, cada sesión arranca su propia copia de cada servidor",
      idle: "ningún servidor corre hasta que se llama una herramienta",
      woke: "arrancó con la primera llamada real",
      log: "una línea por cada llamada que pasa por él",
    },
    result: {
      top: `en la medición, 8 sesiones con cada uno de los 6 servidores corriendo una vez: ${mib(BENCH.running[0])} MiB, ${BENCH.running[1]} procesos`,
      direct: `en la medición, las mismas 8 sesiones sin el gateway: ${mib(BENCH.direct[0])} MiB, ${BENCH.direct[1]} procesos`,
      running: `en la medición: ${LESS.running}% menos con todos los servidores corriendo`,
      both: `en la medición: ${LESS.running}% menos con todos los servidores corriendo, ${LESS.idle}% menos cuando están inactivos`,
    },
  },
};

/** The section's commands from copy.ts, typed in a shell. */
export function gatewayCommands(lang: Lang): ChapterCommand[] {
  return landingCopy(lang).sections.gateway.commands.map((command) => ({ ...command, prompt: "$" }));
}

/** One line of `turno mcp log` on a terminal, without its time, duration and sizes. */
const LOGGED = `✓ ok  ${SERVERS[CALLED]}  browser_navigate  personal  claude-code`;

/*
 * The phases of each command and how many beats each holds. Phase 0 is the cut to the command's
 * first state while it types; the copies fall for TRAVEL beats.
 */
const BEATS: Record<number, number[]> = {
  // type, the servers report one per beat, the reading
  0: [4, SERVERS.length, 1],
  // type, each session starts its copies, the reading, the fall, every server once, idle
  1: [4, PER_LANE * 2, 4, TRAVEL, 8, 1],
  // type, the call goes down and along, the server starts, the call comes back, the line
  2: [4, 5, 2, 5, 1],
};

type Chips = "hidden" | "stopped" | "fill" | "running";
type Ghosts = "hidden" | "shown" | "dropped";
/** The sessions' lines to mcpd: gone without the gateway, faint while idle, drawn while in use. */
type Wires = "hidden" | "faint" | "shown";

export default function GatewayPicture({ lang, chosen, run, drawn, armed, reduced, say }: PictureProps) {
  const t = GATEWAY_TEXT[lang];
  const beats = BEATS[chosen] ?? BEATS[0]!;
  const phase = usePhase(`${chosen}-${run}`, beats, run > 0, reduced);
  const p = run > 0 ? phase : 0;

  /* What the picture holds, phase by phase. */
  let chips: Chips = "stopped";
  let ghosts: Ghosts = "hidden";
  let woke = false;
  // Every session reaches mcpd: a line down to the bar, faint until a command needs it.
  let wires: Wires = "faint";
  // The page's own session, while its call goes down its line.
  let calls = false;
  let barText: string = t.bar.rest;
  let reading: ReactNode;
  let result: string | undefined;

  if (run > 0 && chosen === 0) {
    chips = p >= 2 ? "running" : p === 1 ? "fill" : "stopped";
    wires = p >= 1 ? "shown" : "faint";
    barText = t.bar.top;
    if (p >= 2) {
      reading = <Reading mib={BENCH.running[0]} processes={t.processes(BENCH.running[1])} />;
      result = t.result.top;
    }
  } else if (run > 0 && chosen === 1) {
    chips = p >= 4 ? (p >= 5 ? "stopped" : "running") : "hidden";
    ghosts = p >= 3 ? "dropped" : p >= 1 ? "shown" : "hidden";
    wires = p >= 5 ? "faint" : p >= 4 ? "shown" : "hidden";
    barText = p >= 5 ? t.bar.idle : p >= 4 ? t.bar.top : t.bar.direct;
    if (p >= 2 && p < 4) {
      reading = <Reading mib={BENCH.direct[0]} processes={t.processes(BENCH.direct[1])} without />;
      result = t.result.direct;
    }
    if (p === 4) {
      reading = <Reading mib={BENCH.running[0]} processes={t.processes(BENCH.running[1])} less={t.less(LESS.running)} />;
      result = t.result.running;
    }
    if (p >= 5) {
      reading = <Reading mib={BENCH.idle[0]} processes={t.processes(BENCH.idle[1])} less={t.less(LESS.idle)} />;
      result = t.result.both;
    }
  } else if (run > 0 && chosen === 2) {
    woke = p >= 2;
    calls = p >= 1;
    barText = p >= 4 ? t.bar.log : p >= 2 ? t.bar.woke : t.bar.idle;
    reading = <span className={g.lines}>{t.lines(p >= 4 ? 1 : 0)}</span>;
    if (p >= 4) result = LOGGED;
  }

  const typed = gatewayCommands(lang)[chosen]?.run ?? "";
  useEffect(() => {
    if (run > 0) say({ prompt: "$", cmd: typed, result });
  }, [run, typed, result, say]);

  /* The logged call: one dot, out of the session, down into the bar, along it to the server and back. */
  const layer = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLSpanElement>(null);
  const mark = useRef<HTMLSpanElement>(null);
  const dot = useRef<HTMLSpanElement>(null);
  // One animation for the whole call, from phase 1 to 3: the dependency stays true across them.
  const calling = chosen === 2 && run > 0 && !reduced && p >= 1 && p <= 3;
  useLayoutEffect(() => {
    const node = dot.current;
    if (!calling || !node) return;
    const route = measureRoute(layer.current, card.current, bar.current, mark.current);
    if (!route) return;
    const { from, down, across, to } = route;
    const xy = ([x, y]: [number, number]) => ({ transform: `translate(${x}px, ${y}px)` });
    // Out in 5 beats, 2 in the server while it starts, back in 5: the phases of BEATS[2].
    const out = 5 / 12;
    const back = 7 / 12;
    const frames = [
      { ...xy(from), offset: 0, opacity: 1 },
      { ...xy(down), offset: out * 0.35 },
      { ...xy(across), offset: out * 0.8 },
      { ...xy(to), offset: out },
      { ...xy(to), offset: back },
      { ...xy(across), offset: back + (1 - back) * 0.2 },
      { ...xy(down), offset: back + (1 - back) * 0.65 },
      { ...xy(from), offset: 1, opacity: 1 },
    ];
    const animation = node.animate(frames, { duration: 12 * BEAT, easing: "cubic-bezier(0.45, 0, 0.55, 1)" });
    return () => animation.cancel();
  }, [calling]);

  const lane = (index: 0 | 1) => (
    <div className={g.lane} style={{ "--lane": index } as CSSProperties} data-lane={index} data-ghosts={ghosts} data-wires={wires}>
      {Array.from({ length: PER_LANE }, (_, column) => {
        const ours = index === 0 && column === OURS;
        return (
          <div key={column} className={g.column} style={{ "--c": index * PER_LANE + column } as CSSProperties}>
            <span ref={ours ? card : undefined} className={g.session} data-ours={ours || undefined}>
              {ours ? SESSION : null}
            </span>
            <span aria-hidden className={g.wire} data-calls={(ours && calls) || undefined} />
            <span aria-hidden className={g.copies}>
              {SERVERS.map((name) => (
                <i key={name} />
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );

  return (
    <Stage
      active={[true, true]}
      sub={[t.sessions, t.sessions]}
      bar={{ name: "mcpd", text: barText, end: reading }}
      cut={run > 0 && p === 0}
      drawn={drawn}
      armed={armed}
      reduced={reduced}
      layerRef={layer}
      barRef={bar}
    >
      {lane(0)}
      {lane(1)}
      {/* Under the servers: the call runs inside the bar and they stand on it. */}
      <span ref={dot} aria-hidden className={DOT} style={{ opacity: 0 }} />
      <div className={g.shelf} data-chips={chips}>
        {SERVERS.map((name, index) => {
          const on = chips === "running" || (index === CALLED && woke);
          return (
            <span key={name} className={g.chip} data-on={on || undefined} style={{ "--i": index } as CSSProperties}>
              <span ref={index === CALLED ? mark : undefined} aria-hidden className={g.mark} />
              {name}
            </span>
          );
        })}
      </div>
    </Stage>
  );
}

/** The figure on the bar: memory and processes, and what it saves when it is turno's. */
function Reading({ mib: value, processes, less, without = false }: { mib: number; processes: string; less?: string; without?: boolean }) {
  return (
    <span className={g.reading} data-without={without || undefined}>
      <span className={g.figure}>
        {mib(value)} MiB · {processes}
      </span>
      {less ? <span className={g.less}>{less}</span> : null}
    </span>
  );
}

/**
 * The route of the logged call, in the layer's coordinates: out of the session, down into the
 * bar, along it under the server and into its mark. Measured once per call, never per frame.
 */
function measureRoute(layer: HTMLElement | null, card: HTMLElement | null, bar: HTMLElement | null, mark: HTMLElement | null) {
  if (!layer || !card || !bar || !mark) return null;
  // Stacked lanes (a phone): the way down would cross the work lane, so the call does not travel.
  if ((layer.parentElement?.clientWidth ?? 0) < 520) return null;
  const origin = layer.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  const b = bar.getBoundingClientRect();
  const m = mark.getBoundingClientRect();
  const x0 = c.left - origin.left + c.width / 2;
  const x1 = m.left - origin.left + m.width / 2;
  const barY = b.top - origin.top + b.height / 2;
  return {
    from: [x0, c.bottom - origin.top] as [number, number],
    down: [x0, barY] as [number, number],
    across: [x1, barY] as [number, number],
    to: [x1, m.top - origin.top + m.height / 2] as [number, number],
  };
}
