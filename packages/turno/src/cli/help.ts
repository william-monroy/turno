/** The main `turno help` screen: drawn from static rows, so it loads nothing but the style. */
import { type Io, wrap } from "./io.js";
import { padEnd, style } from "./style.js";

export interface HelpSection {
  title: string;
  /** Command name and its one-line summary. */
  rows: readonly (readonly [string, string])[];
}

const EXAMPLES: [string, string][] = [
  ["turno init", "find your agents, accounts and MCP servers, and set them up"],
  ["turno", "this folder, your accounts and their usage, and what to do next"],
  ["turno work", "open the work profile with its agent"],
  ["turno profile assign . work", "make this folder and everything under it use work"],
  ["turno mcp sync", "point every profile at the gateway"],
];

/** Rows of `left  summary`, with summaries wrapped under their column within the width. */
function rows(left: readonly string[], right: readonly string[], leftWidth: number, width: number, paintLeft: (s: string) => string, paintRight: (s: string) => string): string[] {
  const out: string[] = [];
  const col = 2 + leftWidth + 2;
  for (const [i, l] of left.entries()) {
    const body = wrap(right[i] ?? "", Math.max(24, width - col));
    if (l.length > leftWidth) {
      out.push(`  ${paintLeft(l)}`);
      for (const b of body) out.push(`${" ".repeat(col)}${paintRight(b)}`);
      continue;
    }
    out.push(`  ${padEnd(paintLeft(l), leftWidth)}  ${paintRight(body[0]!)}`);
    for (const b of body.slice(1)) out.push(`${" ".repeat(col)}${paintRight(b)}`);
  }
  return out;
}

export function renderHelp(io: Pick<Io, "env" | "isTty">, sections: readonly HelpSection[]): string[] {
  const s = style(io);
  // Help reads best at a modest width even on a wide terminal.
  const width = Math.min(s.width, 100);
  const out: string[] = [];
  const tagline = "one MCP gateway and per-folder accounts for Claude Code, Codex, Copilot CLI and Cursor CLI.";
  const first = wrap(`turno: ${tagline}`, width);
  out.push(s.color ? `${s.bold(s.accent("turno"))}${s.bold(first[0]!.slice("turno".length))}` : first[0]!);
  for (const l of first.slice(1)) out.push(s.bold(l));
  out.push("");
  out.push(`${s.lead("next", "Start here:")} ${s.bold(s.accent("turno init"))}, or ${s.accent("turno demo")} to try turno in a throwaway HOME.`);

  const usage = ["turno <command> [flags]", "turno <profile> [args...]"];
  out.push("", s.header("Usage"));
  out.push(
    ...rows(
      usage,
      ["a command below; turno <command> --help shows its flags", "open that profile with its agent; the arguments after it go to the agent"],
      Math.max(...usage.map((u) => u.length)),
      width,
      (l) => `${s.muted("turno")}${l.slice("turno".length)}`,
      (r) => r,
    ),
  );
  const w = Math.max(...sections.flatMap((x) => x.rows.map(([n]) => n.length)));
  for (const sec of sections) {
    out.push("", s.header(sec.title));
    out.push(
      ...rows(
        sec.rows.map(([n]) => n),
        sec.rows.map(([, sum]) => sum),
        w,
        width,
        (l) => s.bold(s.accent(l)),
        (r) => r,
      ),
    );
  }
  const ew = Math.max(...EXAMPLES.map(([c]) => c.length)) + 2;
  out.push("", s.header("Examples"));
  out.push(
    ...rows(
      EXAMPLES.map(([c]) => `$ ${c}`),
      EXAMPLES.map(([, why]) => why),
      ew,
      width,
      (l) => `${s.muted("$")}${l.slice(1)}`,
      (r) => s.muted(r),
    ),
  );
  out.push("", `Run ${s.bold("turno <command> --help")}, or ${s.bold("turno help <command>")}, for details.`);
  out.push(s.muted("Scripts and agents: --no-input or TURNO_NO_INPUT=1 never asks (exit 2 instead)."));
  return out;
}
