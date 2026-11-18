/**
 * The status line with each part numbered, in its Unicode look (docs/ui.md). The values are an
 * example; the legend under it says what each part means.
 */
const PARTS: [string, string][] = [
  ["Profile and plan", "The pill. Its color comes from the profile's color in config.toml."],
  ["5 h usage", "The account's 5 hour window and the time until it resets."],
  ["Weekly usage", "The account's weekly window and the time until it resets."],
  ["Context", "Context used, as a bar and as tokens."],
  ["Turns left", "Turns left in the 5 h window, estimated from recent turns."],
  ["Project and branch", "The project (and worktree) and its git branch, read without running git."],
  ["Lines changed", "Lines added and removed."],
  ["Model and effort", "The model of the conversation and its effort."],
  ["Cost", "The API-equivalent cost of the conversation, subagents included."],
];

function Mark({ n }: { n: number }) {
  return (
    <sup className="ml-0.5 inline-flex size-4 items-center justify-center rounded-full bg-white/90 align-super font-sans text-[10px] font-bold leading-none text-black">
      {n}
    </sup>
  );
}

const sep = <span className="text-[#5c6370]"> │ </span>;

export function StatusLine() {
  return (
    <figure className="not-prose my-6 overflow-hidden rounded-xl border">
      <div className="overflow-x-auto px-5 py-5 font-mono text-xs leading-8" style={{ backgroundColor: "var(--term-bg)", color: "var(--term-fg)" }}>
        <div className="whitespace-nowrap">
          <span className="rounded-sm px-2 py-0.5 font-semibold text-white" style={{ backgroundColor: "#2457f5" }}>
            ◉ work · Max
          </span>
          <Mark n={1} />
          {sep}
          <span className="text-[#98c379]">⧗ ▰▰▰▱▱▱▱▱ 41%</span> <span className="text-[#abb2bf]">↺ 2h01m</span>
          <Mark n={2} />
          {sep}
          <span className="text-[#e5c07b]">▦ ▰▰▰▰▰▱▱▱ 67%</span> <span className="text-[#abb2bf]">↺ 2d7h</span>
          <Mark n={3} />
          {sep}
          <span className="text-[#98c379]">◔ [##--------] 23%</span> 230k/1M
          <Mark n={4} />
          {sep}
          <span className="text-[#98c379]">▮ ~38 turns</span>
          <Mark n={5} />
        </div>
        <div className="whitespace-nowrap">
          <span className="font-semibold text-[#61afef]">▣ acme</span>
          {sep}
          <span className="text-[#56b6c2]">⎇ main</span>
          <Mark n={6} />
          {sep}± <span className="text-[#98c379]">+128</span> <span className="text-[#e06c75]">−14</span>
          <Mark n={7} />
          {sep}
          <span className="text-[#c678dd]">◈ Opus 5.5 ✦ high</span>
          <Mark n={8} />
          {sep}
          <span className="font-semibold text-[#98c379]">$4.82</span> <span className="text-[#abb2bf]">(sub $1)</span>
          <Mark n={9} />
        </div>
      </div>
      <ol className="grid gap-x-6 gap-y-2 border-t bg-fd-card p-5 text-sm sm:grid-cols-2">
        {PARTS.map(([name, what], i) => (
          <li key={name} className="flex gap-2.5">
            <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-fd-foreground text-[11px] font-bold text-fd-background">{i + 1}</span>
            <span>
              <span className="font-medium text-fd-foreground">{name}.</span> <span className="text-fd-muted-foreground">{what}</span>
            </span>
          </li>
        ))}
      </ol>
    </figure>
  );
}
