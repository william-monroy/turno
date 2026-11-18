"use client";

import { landingCopy, type Lang, type StoryId } from "../copy";
import type { ChapterCommand, PictureProps } from "./section";
import { Stage } from "./stage";

/** What stands before a command: a shell prompt, Claude Code's prompt or a config file. */
export function promptOf(run: string): string {
  if (run.startsWith("/")) return ">";
  if (run.startsWith("[")) return "mcp.toml";
  return "$";
}

/** A chapter's commands straight from copy.ts, for a chapter whose picture is not built yet. */
export function plainCommands(id: StoryId, lang: Lang): ChapterCommand[] {
  return landingCopy(lang).sections[id].commands.map((command) => ({ ...command, prompt: promptOf(command.run), copyable: !command.run.startsWith("[") }));
}

/** Stands in for a chapter picture that is not built yet: the empty stage, so the page keeps its shape. */
export function StubPicture({ drawn, armed, reduced }: PictureProps) {
  return <Stage active={[true, false]} sub={["", ""]} bar={{ name: "turno", text: "" }} cut={false} drawn={drawn} armed={armed} reduced={reduced} />;
}
