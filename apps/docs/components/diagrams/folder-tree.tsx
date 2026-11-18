/**
 * A folder tree where each folder shows the profile that opens it, in that profile's color:
 * a rule covers a folder and everything under it, and the longest matching path wins.
 */
type Row = { depth: number; last: boolean[]; name: string; profile: "work" | "personal"; note: string; rule?: boolean };

const ROWS: Row[] = [
  { depth: 0, last: [], name: "~/code/", profile: "personal", note: "no rule: the default profile" },
  { depth: 1, last: [false], name: "acme/", profile: "work", note: "turno profile assign ~/code/acme work", rule: true },
  { depth: 2, last: [false, false], name: "api/", profile: "work", note: "under acme, so the same rule" },
  { depth: 2, last: [false, true], name: "web/", profile: "work", note: "a git worktree matches its main repository's rule" },
  { depth: 1, last: [false], name: "oss/", profile: "personal", note: 'default, with a server set: mcp_deny = ["mail"]', rule: true },
  { depth: 1, last: [true], name: "notes/", profile: "personal", note: "no rule: the default profile" },
];

const PILL: Record<Row["profile"], string> = { work: "var(--pill-work)", personal: "var(--pill-personal)" };

function branch(row: Row): string {
  if (row.depth === 0) return "";
  const lead = row.last.slice(0, -1).map((l) => (l ? "   " : "│  ")).join("");
  return `${lead}${row.last.at(-1) ? "└─ " : "├─ "}`;
}

export function FolderTree() {
  return (
    <figure className="not-prose my-6 overflow-x-auto rounded-xl border bg-fd-card p-4" aria-label="A folder tree with the profile that opens each folder">
      <table className="w-full min-w-[560px] border-separate border-spacing-y-1 font-mono text-[13px] leading-6">
        <tbody>
          {ROWS.map((row) => (
            <tr key={`${row.depth}-${row.name}`}>
              <td className="whitespace-pre pr-4 text-fd-foreground">
                <span className="text-fd-muted-foreground">{branch(row)}</span>
                <span className={row.rule ? "font-semibold" : undefined}>{row.name}</span>
              </td>
              <td className="pr-4">
                <span className="rounded-full px-2.5 py-0.5 text-xs font-semibold text-white" style={{ backgroundColor: PILL[row.profile] }}>
                  {row.profile}
                </span>
              </td>
              <td className="font-sans text-xs text-fd-muted-foreground">{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
