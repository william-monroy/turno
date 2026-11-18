/**
 * A decision tree for a server's scope in mcp.toml: three questions, four answers
 * (docs/mcp.md, "Choosing a scope" and "Browsers").
 */
const fg = "var(--color-fd-foreground)";
const muted = "var(--color-fd-muted-foreground)";
const border = "var(--color-fd-border)";
const card = "var(--color-fd-background)";

function Question({ y, lines }: { y: number; lines: string[] }) {
  return (
    <g>
      <rect x="20" y={y} width="330" height="58" rx="10" fill={card} stroke={fg} strokeOpacity="0.5" />
      {lines.map((l, i) => (
        <text key={l} x="36" y={y + (lines.length === 1 ? 34 : 25 + i * 18)} fontSize="13" fill={fg}>
          {l}
        </text>
      ))}
    </g>
  );
}

function Answer({ y, scope, config, note }: { y: number; scope: string; config: string; note: string }) {
  return (
    <g>
      <line x1="350" y1={y + 29} x2="436" y2={y + 29} stroke="var(--turno-3)" strokeWidth="1.5" />
      <path d={`M 436 ${y + 29} l -7 -4 v 8 z`} fill="var(--turno-3)" />
      <text x="393" y={y + 22} fontSize="11" textAnchor="middle" fill={muted}>
        yes
      </text>
      <rect x="440" y={y} width="300" height="58" rx="10" fill="var(--turno-4)" fillOpacity="0.1" stroke="var(--turno-4)" />
      <text x="456" y={y + 24} fontSize="13.5" fontWeight="700" fill={fg}>
        {scope}
      </text>
      <text x="732" y={y + 24} fontSize="11.5" textAnchor="end" fill={muted} className="font-mono">
        {config}
      </text>
      <text x="456" y={y + 43} fontSize="11.5" fill={muted}>
        {note}
      </text>
    </g>
  );
}

function Down({ y }: { y: number }) {
  return (
    <g>
      <line x1="185" y1={y} x2="185" y2={y + 30} stroke={border} strokeWidth="1.5" />
      <path d={`M 185 ${y + 34} l -4 -7 h 8 z`} fill={muted} />
      <text x="196" y={y + 21} fontSize="11" fill={muted}>
        no
      </text>
    </g>
  );
}

export function ScopeTree() {
  return (
    <figure className="not-prose my-6 overflow-x-auto rounded-xl border bg-fd-card p-4">
      <svg viewBox="0 0 760 380" role="img" aria-label="A decision tree to choose the scope of an MCP server: session, project, exclusive or shared" className="mx-auto h-auto w-full min-w-[640px] max-w-[860px] font-sans">
        <Question y={16} lines={["Does it keep state per conversation,", "like a throwaway browser?"]} />
        <Answer y={16} scope="session" config='scope = "session"' note="one process per agent session, stopped when it ends" />
        <Down y={74} />

        <Question y={110} lines={["Does it read the folder it runs in,", "like a code index or a linter?"]} />
        <Answer y={110} scope="project" config='scope = "project"' note="one process per git repository" />
        <Down y={168} />

        <Question y={204} lines={["Can only one session use it at a time,", "or does it ask the user questions?"]} />
        <Answer y={204} scope="exclusive" config="exclusive = true" note="shared, one session at a time (a signed-in browser)" />
        <Down y={262} />

        <rect x="20" y="298" width="330" height="62" rx="10" fill="var(--turno-4)" fillOpacity="0.1" stroke="var(--turno-4)" />
        <text x="36" y="323" fontSize="13.5" fontWeight="700" fill={fg}>
          shared
        </text>
        <text x="342" y="323" fontSize="11.5" textAnchor="end" fill={muted} className="font-mono">
          scope = &quot;shared&quot; (the default)
        </text>
        <text x="36" y="343" fontSize="11.5" fill={muted}>
          one process for every session: API clients, docs, search
        </text>
      </svg>
    </figure>
  );
}
