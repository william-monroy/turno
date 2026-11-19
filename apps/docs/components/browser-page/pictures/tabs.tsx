"use client";

import { type CSSProperties, useEffect } from "react";
import type { PictureProps } from "../../landing/chapters/section";
import { usePhase } from "../../landing/chapters/stage";
import { browserCopy, CMD, PRINTS, SITE, TOOL } from "../copy";
import { Lines, Shot, Squares, type Win, Window } from "./parts";
import s from "./pictures.module.css";

/*
 * A browser that cleans up. The tab governor of turno-browser keeps at most `max` pages (8):
 * past it the least recently used one closes, never the agent's current tab. A page unused for
 * `park` (5 minutes) goes to about:blank and stops running; after `close` (15 minutes) it
 * closes. Chrome itself closes after 15 minutes without a tool call and opens again, with the
 * same profile, on the next one. Every limit is a setting of the identity.
 */

type TabState = "run" | "park" | "closing";
interface Tab {
  name: string;
  state: TabState;
  current?: boolean;
}

/** The pages of the example, oldest first: the last is the one the agent is on. */
const NAMES = ["mail", "docs", "api", "repo", "wiki", "cal", "forms", "news"];

function pages(parkedUntil = 0): Tab[] {
  return NAMES.map((name, index) => ({ name, state: index < parkedUntil ? "park" : "run", current: index === NAMES.length - 1 }));
}

/** The phases of each step and how many beats each holds. */
const BEATS: Record<number, number[]> = {
  0: [4, 4, 4, 1],
  1: [4, 4, 1],
  2: [4, 5, 5, 1],
  3: [4, 1],
};

/** How many pages the idle rule parks in the example: all but the two used last. */
const PARKED = 6;

export default function TabsPicture({ lang, chosen, run, drawn, armed, reduced, say }: PictureProps) {
  const copy = browserCopy(lang);
  const t = copy.pictures.tabs;
  const rows = copy.chapters.tabs.commands;
  const beats = BEATS[chosen] ?? BEATS[0]!;
  const phase = usePhase(`${chosen}-${run}`, beats, run > 0, reduced);
  const p = run > 0 ? phase : 0;

  /* What each step draws: the pages, the cap, the clock and whether Chrome runs. */
  let tabs: Tab[] = pages();
  let cap = 8;
  let clock: string | undefined;
  let win: Win = "open";
  let prompt = "tool";
  let cmd: string = `${TOOL.tabs} new`;
  let result: string | undefined;

  if (chosen === 0) {
    // A ninth page: it becomes the agent's tab, and the least recently used one closes.
    if (p >= 1) {
      tabs = [...pages().map((tab) => ({ ...tab, current: false })), { name: "new", state: "run", current: true }];
    }
    if (p === 2) tabs[0] = { ...tabs[0]!, state: "closing" };
    if (p >= 3) {
      tabs = tabs.slice(1);
      result = PRINTS.capped;
    }
  } else if (chosen === 1) {
    prompt = "…";
    cmd = rows[1]!.run;
    if (p >= 1) clock = t.later5;
    if (p >= 2) {
      tabs = pages(PARKED);
      result = PRINTS.parked;
    }
  } else if (chosen === 2) {
    prompt = "…";
    cmd = rows[2]!.run;
    tabs = pages(PARKED);
    clock = t.later5;
    if (p >= 1) {
      clock = t.later15;
      tabs = tabs.slice(PARKED);
      result = PRINTS.closed;
    }
    if (p >= 2) {
      win = "closed";
      tabs = [];
      result = t.idle;
    }
    if (p >= 3) {
      win = "open";
      tabs = [{ name: NAMES[NAMES.length - 1]!, state: "run", current: true }];
      result = t.again;
    }
  } else {
    prompt = "$";
    cmd = CMD.set;
    if (p >= 1) {
      cap = 12;
      result = t.written;
    }
  }
  useEffect(() => {
    if (run > 0) say({ prompt, cmd, result });
  }, [run, prompt, cmd, result, say]);

  const running = tabs.filter((tab) => tab.state !== "park").length;
  const parked = tabs.length - running;

  return (
    <Shot drawn={drawn} armed={armed}>
      <div className={s.top}>
        <span className={s.meter}>
          <span className={s.count}>
            {t.running} <b>{running}</b>
            <Squares n={running} kind="run" />
          </span>
          <span className={s.count}>
            {t.parked} <b>{parked}</b>
            <Squares n={parked} kind="park" />
          </span>
        </span>
        <span className={s.clock} data-off={clock ? undefined : true}>
          {clock ?? t.later15}
        </span>
      </div>

      <Window
        win={win}
        url={win === "open" ? `${SITE}/news` : t.chromeClosed}
        strip={
          <div className={s.stripWrap}>
            <div className={s.strip} data-cap={cap} style={{ "--cap": cap } as CSSProperties}>
              {tabs.map((tab) => (
                <span key={tab.name} className={s.tab} data-state={tab.state} data-current={tab.current || undefined}>
                  <i aria-hidden />
                  <span>{tab.state === "park" ? "blank" : tab.name}</span>
                </span>
              ))}
              {/* A row keeps its height even with no page open. */}
              {tabs.length === 0 ? <span aria-hidden className={s.tab} style={{ visibility: "hidden" }} /> : null}
              <span className={s.cap}>
                <span>
                  {t.cap} {cap}
                </span>
              </span>
            </div>
          </div>
        }
      >
        {win === "open" ? (
          <div className={`${s.page} ${s.pageShort}`}>
            <Lines />
          </div>
        ) : (
          <div className={`${s.page} ${s.pageShort}`} data-center>
            <span className={s.quiet}>{t.onDisk}</span>
          </div>
        )}
      </Window>
    </Shot>
  );
}
