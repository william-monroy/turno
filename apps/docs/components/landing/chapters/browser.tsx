"use client";

import { type CSSProperties, Fragment, type ReactNode, type RefObject, useEffect, useRef } from "react";
import { landingCopy, type Lang } from "../copy";
import { AccountPill, type Tone } from "../kit";
import s from "./browser.module.css";
import { Below, Frame, useTravel } from "./logins";
import l from "./logins.module.css";
import type { ChapterCommand, PictureProps } from "./section";
import { type Lane, place, Stage, TRAVEL, usePhase } from "./stage";

/*
 * Chapter 3: a browser per identity. `turno open [profile] <url>` opens a claude.ai link in the
 * profile's own Chrome profile (~/.local/share/turno/chrome/<profile>, cli/commands/open.ts and
 * docs/security.mdx) and any other link in the default browser; it prints nothing. A browser
 * identity is turno-browser's: one persistent Chrome profile under
 * ~/.local/share/turno/browser/identities/<id> that an agent drives through mcpd as the server
 * browser-<id>, one session at a time (docs/guides/signed-in-browser.mdx). `turno identity add`
 * creates it and prints its mcp.toml block; `turno identity login` opens its Chrome to sign in by
 * hand, and closing the window saves the session (cli/commands/browser.ts). It is not an
 * account, so it does not get a lane: it hangs under the bar, reached through the gateway.
 */

const LINK = "https://claude.ai/new";
const CHROME = "~/.local/share/turno/chrome";

/**
 * Where the link chip lands inside a window, from its top-left corner, so its text meets the
 * address text: border 1.5, padding 12, three 6 px buttons with 4 px gaps, a 10 px gap, less the
 * chip's own border and padding; and centered on the 33 px strip.
 */
const ADDRESS: [number, number] = [1.5 + 12 + 26 + 10 - 10.5, 1.5 + 4];
const IDENTITY = "~/.local/share/turno/browser/identities/school";

export const BROWSER_TEXT = {
  en: {
    figure: "Two accounts, each with its own Chrome profile, and a browser identity under the gateway. Choose a command to run it here.",
    sub: "its own Chrome profile",
    identity: "an agent drives it",
    open: "claude.ai links open in that profile's own Chrome profile",
    gateway: "one local process every session of every agent reaches",
    served: "[server.browser-school] · one session uses it at a time",
    signedIn: "signed in",
    notYet: "not signed in yet",
    none: "no browser identity yet",
    byHand: "sign in by hand, then close the window",
    kept: "cookies kept",
    result: {
      opened: "opened in work's own Chrome profile, already signed in",
    },
  },
  es: {
    figure: "Dos cuentas, cada una con su perfil de Chrome, y una identidad del navegador bajo el gateway. Elige un comando para correrlo aquí.",
    sub: "su propio perfil de Chrome",
    identity: "lo maneja un agente",
    open: "los enlaces de claude.ai se abren en el perfil de Chrome de ese perfil",
    gateway: "un solo proceso local al que llegan todas las sesiones de todos los agentes",
    served: "[server.browser-school] · lo usa una sesión a la vez",
    signedIn: "sesión iniciada",
    notYet: "sin sesión todavía",
    none: "todavía no hay identidades del navegador",
    byHand: "inicia sesión a mano y cierra la ventana",
    kept: "cookies guardadas",
    result: {
      opened: "se abrió en el perfil de Chrome de work, con la sesión ya iniciada",
    },
  },
};

/** The section's commands from copy.ts, all typed in a shell. */
export function browserCommands(lang: Lang): ChapterCommand[] {
  return landingCopy(lang).sections.browser.commands.map((command) => ({ ...command, prompt: "$" }));
}

/*
 * The phases of each command and how many beats each holds. Open: typing, the link on the bar,
 * its way up into work's window, landed. Add: typing, the identity drops in under the bar, its
 * block for mcp.toml (the bar names its server), the last line it prints. Login: typing, its
 * Chrome opens, you sign in, you close it and it is saved.
 */
const BEATS: Record<number, number[]> = {
  0: [4, 2, TRAVEL, 1],
  1: [4, 4, 4, 1],
  2: [4, 4, 4, 1],
};

type Win = "closed" | "open";

export default function BrowserPicture({ lang, chosen, run, drawn, armed, reduced, say }: PictureProps) {
  const t = BROWSER_TEXT[lang];
  const beats = BEATS[chosen] ?? BEATS[0]!;
  const phase = usePhase(`${chosen}-${run}`, beats, run > 0, reduced);
  const p = run > 0 ? phase : 0;

  /* The line under the picture. */
  let cmd = `turno open work ${LINK}`;
  let result: string | undefined;
  if (chosen === 0) {
    if (p >= 3) result = t.result.opened;
  } else if (chosen === 1) {
    cmd = "turno identity add browser:school";
    if (p >= 1) result = `identity "school" ready at ${IDENTITY}`;
    if (p >= 2) result = "Add this to ~/.config/turno/mcp.toml, then run `turno mcp sync`:";
    if (p >= 3) result = "Sign in to your sites once with `turno identity login browser:school`.";
  } else {
    cmd = "turno identity login browser:school";
    if (p >= 1) result = `Opening Chrome for identity "school". Sign in to your sites, then close the window to save the session.`;
    if (p >= 3) result = "saved. Sessions using browser-school now start signed in.";
  }
  useEffect(() => {
    if (run > 0) say({ prompt: "$", cmd, result });
  }, [run, cmd, result, say]);

  /* The link leaves turno open, on the bar, for the address bar of work's window. */
  const frame = useRef<HTMLDivElement>(null);
  const launch = useRef<HTMLSpanElement>(null);
  const workWin = useRef<HTMLDivElement>(null);
  const traveler = useRef<HTMLDivElement>(null);
  useTravel({ on: chosen === 0 && p === 2 && !reduced, frame, from: launch, to: workWin, node: traveler, beats: TRAVEL, align: "start", offset: ADDRESS });

  /* What each command draws. The commands read in order: each starts where the last one rests. */
  const workOpen = chosen > 0 || p >= 3;
  const school = chosen === 2 || (chosen === 1 && p >= 1);
  const schoolWin: Win = chosen === 2 && (p === 1 || p === 2) ? "open" : "closed";
  const schoolState = chosen === 2 && p >= 2 ? "signedIn" : chosen === 2 && p === 1 ? "byHand" : "notYet";

  return (
    <Frame frameRef={frame} drawn={drawn} armed={armed} reduced={reduced}>
      <Stage
        active={[true, workOpen]}
        sub={[t.sub, t.sub]}
        bar={chosen === 0 ? { name: "turno open", text: t.open } : { name: "mcpd", text: chosen === 1 && p < 2 ? t.gateway : t.served }}
        cut={run > 0 && p === 0}
        drawn={drawn}
        armed={armed}
        reduced={reduced}
      >
        <Window lane={0} tone="personal" win="open" url="claude.ai/new" path={`${CHROME}/personal`} line={<Signed label={t.signedIn} />} />
        <Window
          lane={1}
          tone="work"
          win={workOpen ? "open" : "closed"}
          url={workOpen ? "claude.ai/new" : ""}
          path={`${CHROME}/work`}
          line={<Signed label={t.signedIn} />}
          winRef={workWin}
        />
        {chosen === 0 ? (
          <span ref={launch} aria-hidden className={l.onBar} style={{ visibility: p === 1 ? "visible" : "hidden" }}>
            <Link />
          </span>
        ) : null}
      </Stage>

      {/* The identity's place is always there, so the picture keeps its height; empty and quiet until the identity is added. */}
      <Below>
        <div className={s.identity} data-drop={(chosen === 1 && p === 1 && !reduced) || undefined}>
          <div className={s.slot} data-empty={!school || undefined}>
            <WindowBox
              tone="third"
              win={schoolWin}
              head={
                <>
                  <AccountPill tone="third" quiet={schoolWin === "closed"}>
                    browser:school
                  </AccountPill>
                  <span className={s.identitySub}>{t.identity}</span>
                </>
              }
              path={IDENTITY}
              line={
                schoolState === "signedIn" ? (
                  <Signed label={t.signedIn} more={schoolWin === "closed" ? t.kept : undefined} />
                ) : (
                  <span className={s.quiet}>{schoolState === "byHand" ? t.byHand : t.notYet}</span>
                )
              }
            />
            {school ? null : <span className={s.none}>{t.none}</span>}
          </div>
        </div>
      </Below>

      <div ref={traveler} aria-hidden className={l.traveler}>
        <Link />
      </div>
    </Frame>
  );
}

/* Parts --------------------------------------------------------------------------------------- */

/** The link on its way: carried by turno, so blue. */
function Link() {
  return <span className={s.link}>claude.ai/new</span>;
}

function Signed({ label, more }: { label: string; more?: string }) {
  return (
    <span className={s.signed}>
      <span aria-hidden>✓</span> {label}
      {more ? <span className={s.quiet}> · {more}</span> : null}
    </span>
  );
}

/** A Chrome window in a lane: the account's own profile. */
function Window({ lane, ...rest }: { lane: Lane } & WindowProps) {
  return (
    <div className={l.at} style={place(lane)}>
      <WindowBox {...rest} />
    </div>
  );
}

interface WindowProps {
  tone: Tone;
  /** Open is a running Chrome; closed is the profile on disk, dashed, still signed in. */
  win: Win;
  /** The address bar's text while it runs. */
  url?: string;
  /** What stands in the window's top strip instead of the address: an identity's own name. */
  head?: ReactNode;
  path: string;
  line: ReactNode;
  winRef?: RefObject<HTMLDivElement | null>;
}

function WindowBox({ tone, win, url = "", head, path, line, winRef }: WindowProps) {
  return (
    <div ref={winRef} className={s.win} data-win={win} data-head={head ? true : undefined} style={{ "--tone": `var(--tone-${tone})` } as CSSProperties}>
      <div className={s.address}>
        {head ?? (
          <>
            <span aria-hidden className={s.lights}>
              <i />
              <i />
              <i />
            </span>
            <span className={s.url}>
              {url}
            </span>
          </>
        )}
      </div>
      <div className={s.body}>
        {line}
        <Path path={path} />
      </div>
    </div>
  );
}

/** A folder that may wrap only after a slash, never inside a name. */
function Path({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <span className={s.path}>
      {parts.map((part, index) => (
        // Segments of a fixed path: their order never changes.
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 ? (
            <>
              /<wbr />
            </>
          ) : null}
        </Fragment>
      ))}
    </span>
  );
}
