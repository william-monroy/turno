"use client";

import type { ComponentType } from "react";
import { type Lang, landingCopy, SECTION_IDS, type StoryId } from "../copy";
import AccountsPicture, { ACCOUNTS_TEXT, accountsCommands } from "./accounts";
import AgentsPicture, { AGENTS_TEXT, agentsCommands } from "./agents";
import BrowserPicture, { BROWSER_TEXT, browserCommands } from "./browser";
import ContextPicture, { CONTEXT_TEXT, contextCommands } from "./context";
import GatewayPicture, { GATEWAY_TEXT, gatewayCommands } from "./gateway";
import LoginsPicture, { LOGINS_TEXT, loginsCommands } from "./logins";
import { Chapter, type ChapterCommand, type PictureProps } from "./section";
import SkillsPicture, { SKILLS_TEXT, skillsCommands } from "./skills";
import StartPicture, { START_TEXT, startCommands } from "./start";

interface ChapterEntry {
  Picture: ComponentType<PictureProps>;
  commands(lang: Lang): ChapterCommand[];
  text: Record<Lang, { figure: string }>;
}

/** One picture per chapter of the story, by section id. */
const CHAPTERS: Record<StoryId, ChapterEntry> = {
  context: { Picture: ContextPicture, commands: contextCommands, text: CONTEXT_TEXT },
  logins: { Picture: LoginsPicture, commands: loginsCommands, text: LOGINS_TEXT },
  browser: { Picture: BrowserPicture, commands: browserCommands, text: BROWSER_TEXT },
  skills: { Picture: SkillsPicture, commands: skillsCommands, text: SKILLS_TEXT },
  accounts: { Picture: AccountsPicture, commands: accountsCommands, text: ACCOUNTS_TEXT },
  gateway: { Picture: GatewayPicture, commands: gatewayCommands, text: GATEWAY_TEXT },
  agents: { Picture: AgentsPicture, commands: agentsCommands, text: AGENTS_TEXT },
  start: { Picture: StartPicture, commands: startCommands, text: START_TEXT },
};

const LIST: Record<Lang, string> = {
  en: "Commands: choose one to run it in the picture",
  es: "Comandos: elige uno para correrlo en la imagen",
};

const STORY_IDS = SECTION_IDS.filter((id): id is StoryId => id !== "hero");

/** The two secondary chapters: tighter and smaller, never pinned. They give the page its rhythm. */
const QUIET = new Set<StoryId>(["accounts", "agents"]);

/** The eight chapters of the story, in order. On wide screens the scroll steps through each chapter's commands. */
export function Chapters({ lang }: { lang: Lang }) {
  const t = landingCopy(lang);
  return (
    <>
      {STORY_IDS.map((id, index) => {
        const chapter = CHAPTERS[id];
        return (
          <Chapter
            key={id}
            id={id}
            n={index + 1}
            lang={lang}
            copy={t.sections[id]}
            commands={chapter.commands(lang)}
            Picture={chapter.Picture}
            labels={{ list: LIST[lang], copy: t.rail.copy, copied: t.rail.copied, figure: chapter.text[lang].figure }}
            scrollSteps
            quiet={QUIET.has(id)}
          />
        );
      })}
    </>
  );
}
