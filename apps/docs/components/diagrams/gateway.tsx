/**
 * Before and after: eight sessions that each start their own six MCP servers, and the same
 * eight sessions behind one gateway. The numbers are the benchmark's (BENCHMARKS.md).
 */
const TEXT: Record<string, Record<string, string>> = {
  en: {
    label: "Eight agent sessions with six MCP servers each, without turno and with turno",
    before: "Without turno",
    beforeNote: "every session starts its own copy of every server",
    beforeTotal: "56 processes · 3,163 MiB",
    after: "With turno",
    afterNote: "one gateway, each server started once, on first use",
    afterTotal: "8 processes · 847 MiB",
    afterIdle: "1 process · 103 MiB while the servers sit idle",
    sessions: "8 sessions",
    servers: "6 servers",
  },
  es: {
    label: "Ocho sesiones de agentes con seis servidores MCP cada una, sin turno y con turno",
    before: "Sin turno",
    beforeNote: "cada sesión arranca su propia copia de cada servidor",
    beforeTotal: "56 procesos · 3,163 MiB",
    after: "Con turno",
    afterNote: "un gateway, cada servidor una sola vez, al primer uso",
    afterTotal: "8 procesos · 847 MiB",
    afterIdle: "1 proceso · 103 MiB con los servidores inactivos",
    sessions: "8 sesiones",
    servers: "6 servidores",
  },
};

const fg = "var(--color-fd-foreground)";
const muted = "var(--color-fd-muted-foreground)";
const border = "var(--color-fd-border)";
const card = "var(--color-fd-card)";
const SHADES = ["var(--turno-1)", "var(--turno-2)", "var(--turno-3)"];

export function GatewayDiagram({ lang = "en" }: { lang?: string }) {
  const t = TEXT[lang] ?? TEXT.en!;
  const sessions = Array.from({ length: 8 }, (_, i) => i);
  const servers = Array.from({ length: 6 }, (_, i) => i);
  const colX = (i: number) => 34 + i * 38;
  return (
    <figure className="not-prose my-6 overflow-x-auto rounded-xl border bg-fd-card p-4">
      <svg viewBox="0 0 760 330" role="img" aria-label={t.label} className="mx-auto h-auto w-full min-w-[640px] max-w-[860px] font-sans">
        {/* Without turno */}
        <text x="20" y="26" fontSize="15" fontWeight="600" fill={fg}>
          {t.before}
        </text>
        <text x="20" y="45" fontSize="11.5" fill={muted}>
          {t.beforeNote}
        </text>
        {sessions.map((s) => (
          <g key={s}>
            <rect x={colX(s) - 14} y="62" width="28" height="18" rx="5" fill={card} stroke={fg} strokeOpacity="0.55" />
            <line x1={colX(s)} y1="80" x2={colX(s)} y2="232" stroke={border} />
            {servers.map((v) => (
              <circle key={v} cx={colX(s)} cy={100 + v * 26} r="7" fill={SHADES[v % 3]} className="turno-pulse" style={{ animationDelay: `${((s * 3 + v) % 8) * 0.3}s` }} />
            ))}
          </g>
        ))}
        <text x="20" y="262" fontSize="11.5" fill={muted}>
          {t.sessions} × {t.servers}
        </text>
        <text x="20" y="288" fontSize="16" fontWeight="600" fill={fg}>
          {t.beforeTotal}
        </text>

        <line x1="372" y1="16" x2="372" y2="314" stroke={border} strokeDasharray="4 5" />

        {/* With turno */}
        <text x="400" y="26" fontSize="15" fontWeight="600" fill={fg}>
          {t.after}
        </text>
        <text x="400" y="45" fontSize="11.5" fill={muted}>
          {t.afterNote}
        </text>
        {sessions.map((s) => (
          <g key={s}>
            <rect x={colX(s) + 380 - 14} y="62" width="28" height="18" rx="5" fill={card} stroke={fg} strokeOpacity="0.55" />
            <path d={`M ${colX(s) + 380} 80 C ${colX(s) + 380} 112, 566 104, 566 134`} fill="none" stroke="var(--turno-3)" strokeWidth="1.3" className="turno-flow" />
          </g>
        ))}
        <rect x="446" y="134" width="240" height="36" rx="18" fill="var(--turno-4)" />
        <text x="566" y="157" fontSize="13" fontWeight="600" textAnchor="middle" fill="#fff" className="font-mono">
          mcpd · 127.0.0.1
        </text>
        {servers.map((v) => {
          const x = 466 + v * 40;
          return (
            <g key={v}>
              <path d={`M 566 170 C 566 190, ${x} 186, ${x} 208`} fill="none" stroke={border} strokeWidth="1.3" />
              <circle cx={x} cy="216" r="8" fill={SHADES[v % 3]} />
            </g>
          );
        })}
        <text x="400" y="262" fontSize="11.5" fill={muted}>
          {t.sessions} · mcpd · {t.servers}
        </text>
        <text x="400" y="288" fontSize="16" fontWeight="600" fill={fg}>
          {t.afterTotal}
        </text>
        <text x="400" y="308" fontSize="11.5" fill={muted}>
          {t.afterIdle}
        </text>
      </svg>
    </figure>
  );
}
