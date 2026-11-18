"use client";

import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { landingCopy } from "../copy";
import { BEAT } from "../story";
import { FORKED, SESSION, WHERE } from "./context";
import type { ChapterCommand, PictureProps } from "./section";
import { Artifact, DOT, Package, Place, Service, Session, Stage, TRAVEL, type Turn, usePhase } from "./stage";
import s from "./skills.module.css";

/*
 * Chapter 4: four moves between accounts on one picture instead of four boards. The three skills
 * of the Claude Code plugin (plugins/turno/skills) print a command and copy it, or copy an
 * artifact in two steps; the accounts bridge is a builtin server of the gateway, not a skill
 * (accounts/builtin.ts): accounts_delegate runs a read with the account's read tools only, asks
 * before a write, and every call goes to ~/.local/state/turno/audit.jsonl (accounts/audit.ts).
 * See docs/concepts/skills.mdx.
 */

const PACKAGE = "~/.cache/turno/artifacts";

export const SKILLS_TEXT = {
  en: {
    figure: "Two accounts and the moves between them. Choose a command to run it here.",
    login: "its own login",
    session: "session",
    forkOf: "fork of",
    hub: "conversations shared by every profile",
    cache: "the package, readable only by you",
    gateway: "gateway",
    bridge: "accounts bridge, a builtin server",
    audit: (n: number) => `audit.jsonl · ${n} ${n === 1 ? "line" : "lines"}`,
    exited: "ended here with /exit",
    artifact: "q3-plan",
    newTag: "new",
    package: "package",
    confirm: "write to linear:work?",
    allow: "allow",
    deny: "deny",
    bridgeRow: {
      run: "accounts_delegate",
      note: "The accounts bridge, a builtin server of the gateway and not a skill: a read gets only the account's read tools, a write asks you first, and every call goes to an audit log.",
    },
    turns: {
      first: "add rate limiting to the api",
      firstDone: "edited src/limits.ts  +24 −3",
      next: "now cover it with tests",
      nextDone: "wrote test/limits.test.ts  +41",
      side: "update the changelog",
      ask: "what is open in linear:work?",
      answer: "3 open issues, marked as data from work",
      file: "file a bug for the rate limit",
      filed: "filed in linear:work",
      refused: "not filed: you said no",
    },
    result: {
      switchCopied: `copied: cd ${WHERE} && turno work --resume ${SESSION}…`,
      switchDone: "after /exit and a paste, the same session goes on as work",
      forkCopied: `copied: cd ${WHERE} && turno personal --resume ${SESSION}… --fork-session`,
      forkDone: "a copy goes on as personal in a new terminal; this one stays as work",
      packed: `packed in ${PACKAGE}, readable only by you`,
      imported: "a new artifact of personal; the original stays with work",
      read: "runs in work with read tools only, without asking",
      readDone: "read done, marked as data from another account, logged",
      waits: "a write waits for your confirmation in this session",
      allowed: "allowed: it ran in work with the account's tools, logged",
      refused: "refused: nothing ran, and that was logged too",
    },
  },
  es: {
    figure: "Dos cuentas y los movimientos entre ellas. Elige un comando para correrlo aquí.",
    login: "su propio inicio de sesión",
    session: "sesión",
    forkOf: "copia de",
    hub: "conversaciones que comparten todos los perfiles",
    cache: "el paquete, solo tú puedes leerlo",
    gateway: "gateway",
    bridge: "puente de cuentas, un servidor integrado",
    audit: (n: number) => `audit.jsonl · ${n} ${n === 1 ? "línea" : "líneas"}`,
    exited: "terminó aquí con /exit",
    artifact: "q3-plan",
    newTag: "nuevo",
    package: "paquete",
    confirm: "¿escribir en linear:work?",
    allow: "permitir",
    deny: "rechazar",
    bridgeRow: {
      run: "accounts_delegate",
      note: "El puente de cuentas, un servidor integrado del gateway y no una skill: una lectura solo recibe las herramientas de lectura de la cuenta, una escritura te pregunta antes y cada llamada queda en un registro de auditoría.",
    },
    turns: {
      first: "agrega límite de peticiones a la api",
      firstDone: "edited src/limits.ts  +24 −3",
      next: "ahora cúbrelo con pruebas",
      nextDone: "wrote test/limits.test.ts  +41",
      side: "actualiza el changelog",
      ask: "¿qué hay abierto en linear:work?",
      answer: "3 issues abiertos, marcados como datos de work",
      file: "abre un bug por el límite de peticiones",
      filed: "creado en linear:work",
      refused: "no se creó: dijiste que no",
    },
    result: {
      switchCopied: `copiado: cd ${WHERE} && turno work --resume ${SESSION}…`,
      switchDone: "tras /exit y pegarlo, la misma sesión sigue como work",
      forkCopied: `copiado: cd ${WHERE} && turno personal --resume ${SESSION}… --fork-session`,
      forkDone: "una copia sigue como personal en otra terminal; esta sigue como work",
      packed: `empaquetado en ${PACKAGE}, solo tú puedes leerlo`,
      imported: "un artifact nuevo de personal; el original se queda con work",
      read: "corre en work solo con herramientas de lectura, sin preguntar",
      readDone: "lectura hecha, marcada como datos de otra cuenta, registrada",
      waits: "una escritura espera tu confirmación en esta sesión",
      allowed: "permitida: corrió en work con las herramientas de la cuenta, registrada",
      refused: "rechazada: no corrió nada, y también quedó registrada",
    },
  },
};

/** The three skills from copy.ts, then the bridge, which is a tool call rather than a command. */
export function skillsCommands(lang: "en" | "es"): ChapterCommand[] {
  const bridge = SKILLS_TEXT[lang].bridgeRow;
  return [...landingCopy(lang).sections.skills.commands.map((command) => ({ ...command, prompt: ">" })), { run: bridge.run, note: bridge.note, prompt: "tool", copyable: false }];
}

const HALF = TRAVEL / 2;
const BEATS: Record<number, number[]> = {
  // type, copied, travel to the hairline, to the lane, a turn, the result
  0: [4, 4, HALF, HALF + 1, 3, 1],
  // type, copied, a copy lifts, travel, both accounts, landed, both go on
  1: [4, 4, 2, HALF, HALF + 1, 3, 1],
  // type export, package lifts, down into the cache, packed, type import, up to personal, imported
  2: [4, 2, 5, 3, 4, 6, 1],
  // type the read, the call goes and comes back, answered, type the write, the call waits, asks
  3: [4, 9, 3, 4, 4, 1],
};

type Decision = "allow" | "deny" | null;

export default function SkillsPicture({ lang, chosen, run, drawn, armed, reduced, say }: PictureProps) {
  const t = SKILLS_TEXT[lang];
  const beats = BEATS[chosen] ?? BEATS[0]!;
  const runKey = `${chosen}-${run}`;
  const phase = usePhase(runKey, beats, run > 0, reduced);
  const p = run > 0 ? phase : 0;

  // The reader's answer to the bridge's question belongs to one run.
  const [decision, setDecision] = useState<{ run: string; value: Decision }>({ run: runKey, value: null });
  const decided: Decision = decision.run === runKey ? decision.value : null;
  // After an answer: the call travels on (allow) for a few beats, then the answer lands.
  const after = usePhase(`${runKey}-${decided}`, [5, 1], decided !== null, reduced);
  const landed = decided === "deny" || (decided === "allow" && after >= 1);

  const history: Turn[] = [
    { who: "user", text: t.turns.first, tone: "personal" },
    { who: "agent", text: t.turns.firstDone, tone: "personal" },
  ];
  const next: Turn = { who: "user", text: t.turns.next, tone: "work" };
  const nextDone: Turn = { who: "agent", text: t.turns.nextDone, tone: "work" };
  const id = (value: string) => `${t.session} ${value}`;

  /* The line under the picture. */
  let prompt = ">";
  let cmd = "";
  let result: string | undefined;
  if (chosen === 0) {
    cmd = "/switch-account work";
    if (p >= 1) result = p >= 5 ? t.result.switchDone : t.result.switchCopied;
  } else if (chosen === 1) {
    cmd = "/fork-session personal";
    if (p >= 1) result = p >= 6 ? t.result.forkDone : t.result.forkCopied;
  } else if (chosen === 2) {
    cmd = p >= 4 ? `/copy-artifact import ${PACKAGE}/q3-plan-…` : "/copy-artifact export <url> personal";
    if (p >= 3 && p < 4) result = t.result.packed;
    if (p >= 6) result = t.result.imported;
  } else {
    prompt = "tool";
    cmd = `accounts_delegate account=linear:work write=${p >= 3 ? "true" : "false"}`;
    if (p >= 1 && p < 3) result = p >= 2 ? t.result.readDone : t.result.read;
    if (p >= 4) result = !decided ? t.result.waits : !landed ? undefined : decided === "allow" ? t.result.allowed : t.result.refused;
  }
  useEffect(() => {
    if (run > 0) say({ prompt, cmd, result });
  }, [run, prompt, cmd, result, say]);

  /* The bridge's call: one dot, moved along card, bar and service. */
  const layer = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const service = useRef<HTMLDivElement>(null);
  const dot = useRef<HTMLSpanElement>(null);
  const leg = chosen !== 3 || reduced ? null : p === 1 ? "read" : p === 4 ? "write" : decided === "allow" && p >= 5 ? "allow" : null;
  useLayoutEffect(() => {
    const node = dot.current;
    if (!leg || !node) return;
    const route = measureRoute(layer.current, card.current, bar.current, service.current);
    if (!route) return;
    const { from, down, across, to } = route;
    const xy = ([x, y]: [number, number]) => ({ transform: `translate(${x}px, ${y}px)` });
    const frames =
      leg === "read"
        ? [
            { ...xy(from), offset: 0, opacity: 1 },
            { ...xy(down), offset: 0.14 },
            { ...xy(across), offset: 0.32 },
            { ...xy(to), offset: 0.46 },
            { ...xy(to), offset: 0.56 },
            { ...xy(across), offset: 0.7 },
            { ...xy(down), offset: 0.86 },
            { ...xy(from), offset: 1, opacity: 1 },
          ]
        : leg === "write"
          ? [
              { ...xy(from), offset: 0, opacity: 1 },
              { ...xy(down), offset: 1, opacity: 1 },
            ]
          : [
              { ...xy(down), offset: 0, opacity: 1 },
              { ...xy(across), offset: 0.45 },
              { ...xy(to), offset: 0.85, opacity: 1 },
              { ...xy(to), offset: 1, opacity: 0 },
            ];
    const duration = (leg === "read" ? 8 : leg === "write" ? 2 : 5) * BEAT;
    const animation = node.animate(frames, { duration, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: leg === "write" ? "forwards" : "none" });
    return () => animation.cancel();
  }, [leg]);

  /* What each command draws. */
  let active: [boolean, boolean] = [true, false];
  let barName = "~/.claude";
  let barText: ReactNode = t.hub;
  let barEnd: ReactNode;
  let body: ReactNode;

  if (chosen === 0) {
    const moved = p >= 2;
    active = p >= 3 ? [false, true] : [true, false];
    body = (
      <>
        {moved ? <Place lane={0} label={t.exited} quiet /> : null}
        <Session id={id(SESSION)} where={WHERE} turns={[...history, ...(p >= 4 ? [next] : [])]} lane={moved ? 1 : 0} travel={p >= 2 && p <= 3} />
      </>
    );
  } else if (chosen === 1) {
    const lifted = p >= 2;
    const flying = p >= 3;
    const landed = p >= 5;
    active = p >= 4 ? [true, true] : [false, true];
    body = (
      <>
        <Session id={id(SESSION)} where={WHERE} turns={[...history, next, ...(p >= 6 ? [nextDone] : [])]} lane={1} />
        {lifted ? (
          <Session
            id={id(landed ? FORKED : SESSION)}
            where={landed ? `${t.forkOf} ${SESSION}` : WHERE}
            turns={[...history, next, ...(p >= 6 ? [{ who: "user" as const, text: t.turns.side, tone: "personal" as const }] : [])]}
            lane={flying ? 0 : 1}
            peel={!flying}
            travel={flying && !landed}
          />
        ) : null}
      </>
    );
  } else if (chosen === 2) {
    active = [true, true];
    barName = PACKAGE;
    barText = t.cache;
    const packed = p >= 1;
    const inCache = p >= 2 && p < 5;
    const imported = p >= 6;
    body = (
      <>
        <Session id={id(FORKED)} where={`${t.forkOf} ${SESSION}`} turns={[]} lane={0} compact quiet />
        <Session id={id(SESSION)} where={WHERE} turns={[]} lane={1} compact quiet />
        <Artifact lane={1} y={56} tone="work" name={t.artifact} />
        {packed && !imported ? <Package lane={p >= 5 ? 0 : 1} y={inCache ? "var(--bar-y)" : p >= 5 ? 62 : 108} label={t.package} /> : null}
        {imported ? <Artifact lane={0} y={56} tone="personal" name={t.artifact} tag={t.newTag} /> : null}
      </>
    );
  } else {
    const calling = leg === "read" || (leg === "allow" && !landed);
    active = [true, calling];
    barName = t.gateway;
    barText = t.bridge;
    const audit = (p >= 2 ? 1 : 0) + (landed ? 1 : 0);
    barEnd = t.audit(audit);
    const turns: Turn[] = [
      { who: "user", text: t.turns.ask, tone: "personal" },
      ...(p >= 2 ? [{ who: "agent" as const, text: t.turns.answer, tone: "personal" as const }] : []),
      ...(p >= 3 ? [{ who: "user" as const, text: t.turns.file, tone: "personal" as const }] : []),
      ...(landed ? [{ who: "agent" as const, text: decided === "allow" ? t.turns.filed : t.turns.refused, tone: "personal" as const }] : []),
    ];
    const asking = p >= 5 && !decided;
    body = (
      <>
        <Session id={id(SESSION)} where={WHERE} turns={turns} lane={0} cardRef={card}>
          {asking ? (
            <div className={s.ask} role="group" aria-label={t.confirm}>
              <span className={s.askText}>{t.confirm}</span>
              <button type="button" className={`${s.answer} ${s.allow}`} onClick={() => setDecision({ run: runKey, value: "allow" })}>
                {t.allow}
              </button>
              <button type="button" className={s.answer} onClick={() => setDecision({ run: runKey, value: "deny" })}>
                {t.deny}
              </button>
            </div>
          ) : null}
        </Session>
        <Service lane={1} y={36} name="linear:work" serviceRef={service} />
        <span ref={dot} aria-hidden className={DOT} style={{ opacity: 0 }} />
      </>
    );
  }

  return (
    <Stage
      active={active}
      sub={[t.login, t.login]}
      bar={{ name: barName, text: barText, end: barEnd }}
      cut={run > 0 && p === 0}
      drawn={drawn}
      armed={armed}
      reduced={reduced}
      layerRef={layer}
      barRef={bar}
    >
      {body}
    </Stage>
  );
}

/**
 * The route a call takes, in the layer's coordinates: out of the card, down into the bar, along
 * it under the service, and up into the service. Measured once per leg, never per frame.
 */
function measureRoute(layer: HTMLElement | null, card: HTMLElement | null, bar: HTMLElement | null, service: HTMLElement | null) {
  if (!layer || !card || !bar || !service) return null;
  const origin = layer.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  const b = bar.getBoundingClientRect();
  const v = service.getBoundingClientRect();
  const x0 = c.left - origin.left + Math.min(48, c.width / 4);
  const x1 = v.left - origin.left + Math.min(32, v.width / 2);
  const barY = b.top - origin.top + b.height / 2;
  return {
    from: [x0, c.bottom - origin.top] as [number, number],
    down: [x0, barY] as [number, number],
    across: [x1, barY] as [number, number],
    to: [x1, v.bottom - origin.top] as [number, number],
  };
}
