import { ArrowRight, Boxes, FolderTree as FolderIcon, Globe, PanelBottom, Terminal } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { GatewayDiagram } from "@/components/diagrams/gateway";
import { REPO, localePath } from "@/lib/layout.shared";

interface Copy {
  eyebrow: string;
  title: ReactNode;
  lead: string;
  start: string;
  tryIt: string;
  tryNote: string;
  numbers: [string, string][];
  numbersNote: string;
  benchmark: string;
  whatTitle: string;
  features: { icon: ReactNode; title: string; body: string; href: string }[];
  agentsTitle: string;
  agentsLead: string;
  agentsHead: [string, string, string];
  agentsMore: string;
  guidesTitle: string;
  guides: [string, string][];
  privacyTitle: string;
  privacy: string;
  privacyLink: string;
  footer: string;
}

const AGENTS: [string, string, string][] = [
  ["Claude Code", "~/.claude-<p>, claude-<p>", "turno work"],
  ["Codex CLI", "~/.codex-<p>, codex-<p>", "turno auto --agent codex"],
  ["GitHub Copilot CLI", "~/.copilot-<p>, copilot-<p>", "copilot-work"],
  ["Cursor CLI", "~/.cursor-<p>, cursor-agent-<p>", "cursor-agent-work"],
];

const icon = "size-5 text-fd-primary";

const COPY: Record<string, Copy> = {
  en: {
    eyebrow: "Open source · Apache-2.0 · macOS and Linux",
    title: (
      <>
        One MCP gateway.
        <br />
        One account per folder.
      </>
    ),
    lead: "Every coding-agent session starts its own copy of every MCP server. turno starts each server once, only when a tool is called, behind one local gateway that every session of every agent shares. It also gives each folder its own account.",
    start: "Get started",
    tryIt: "Try it first",
    tryNote: "Runs in a throwaway HOME. Your own setup is not touched.",
    numbers: [
      ["3,163 MiB", "8 sessions, each with its own 6 servers: 56 processes"],
      ["847 MiB", "the same 8 sessions behind turno, all 6 servers running"],
      ["103 MiB", "behind turno while the servers sit idle: 1 process"],
    ],
    numbersNote: "Apple M3, 16 GB, Node 26, 2026-11-16. Run it on your own machine before you quote a number.",
    benchmark: "Method and caveats",
    whatTitle: "What it does",
    features: [
      { icon: <Boxes className={icon} />, title: "One gateway for every session", body: "mcpd listens on 127.0.0.1, answers tool lists from a cache, starts a server on its first call and stops it when idle.", href: "/docs/concepts/gateway" },
      { icon: <FolderIcon className={icon} />, title: "An account per folder", body: "turno profile assign ~/code/acme work, and every agent you open there uses your work login.", href: "/docs/concepts/folder-rules" },
      { icon: <Terminal className={icon} />, title: "Four agents, one setup", body: "The same profiles, folder rules and gateway for Claude Code, Codex, Copilot CLI and Cursor CLI.", href: "/docs/guides/claude-code-and-codex" },
      { icon: <PanelBottom className={icon} />, title: "A status line", body: "The account, its 5 h and weekly usage, context, branch and cost, under the Claude Code prompt.", href: "/docs/concepts/profiles#the-status-line" },
      { icon: <Globe className={icon} />, title: "A browser with real profiles", body: "turno-browser drives your installed Chrome with one persistent profile per identity.", href: "/docs/guides/signed-in-browser" },
    ],
    agentsTitle: "Four agents, one setup",
    agentsLead: "A profile is a folder and a launcher. The agent is the vendor's own, unmodified CLI.",
    agentsHead: ["Agent", "Profile and launcher", "Example"],
    agentsMore: "opencode, Gemini CLI, Goose, Crush, Droid and Kiro can use the gateway too.",
    guidesTitle: "Start from your problem",
    guides: [
      ["I have work and personal accounts", "/docs/guides/work-and-personal"],
      ["Many sessions eat my RAM", "/docs/guides/many-sessions-ram"],
      ["I use Claude Code and Codex", "/docs/guides/claude-code-and-codex"],
      ["Let an agent use my signed-in browser", "/docs/guides/signed-in-browser"],
    ],
    privacyTitle: "Nothing leaves your machine",
    privacy: "No account, no telemetry, no proxy for model traffic. turno never reads, stores or forwards your login tokens: every agent logs in by itself, in its own folder. Each account stays bound by its vendor's terms.",
    privacyLink: "Security and privacy",
    footer: "turno is an independent open-source project. It is not affiliated with, endorsed by or sponsored by any vendor of the tools it works with. Made in Monterrey, Mexico.",
  },
  es: {
    eyebrow: "Código abierto · Apache-2.0 · macOS y Linux",
    title: (
      <>
        Un gateway MCP.
        <br />
        Una cuenta por carpeta.
      </>
    ),
    lead: "Cada sesión de un agente de código arranca su propia copia de cada servidor MCP. turno arranca cada servidor una sola vez, solo cuando se llama una de sus herramientas, detrás de un gateway local que comparten todas las sesiones de todos los agentes. Además, cada carpeta usa su propia cuenta.",
    start: "Empezar",
    tryIt: "Pruébalo primero",
    tryNote: "Corre en un HOME desechable. No toca tu configuración.",
    numbers: [
      ["3,163 MiB", "8 sesiones, cada una con sus 6 servidores: 56 procesos"],
      ["847 MiB", "las mismas 8 sesiones detrás de turno, con los 6 servidores corriendo"],
      ["103 MiB", "detrás de turno con los servidores inactivos: 1 proceso"],
    ],
    numbersNote: "Apple M3, 16 GB, Node 26, 2026-11-16. Córrelo en tu máquina antes de citar un número.",
    benchmark: "Método y salvedades",
    whatTitle: "Qué hace",
    features: [
      { icon: <Boxes className={icon} />, title: "Un gateway para todas las sesiones", body: "mcpd escucha en 127.0.0.1, responde las listas de herramientas desde una caché, arranca un servidor en su primera llamada y lo detiene cuando queda inactivo.", href: "/docs/concepts/gateway" },
      { icon: <FolderIcon className={icon} />, title: "Una cuenta por carpeta", body: "turno profile assign ~/code/acme trabajo, y cada agente que abras ahí usa tu cuenta del trabajo.", href: "/docs/concepts/folder-rules" },
      { icon: <Terminal className={icon} />, title: "Cuatro agentes, una configuración", body: "Los mismos perfiles, reglas de carpeta y gateway para Claude Code, Codex, Copilot CLI y Cursor CLI.", href: "/docs/guides/claude-code-and-codex" },
      { icon: <PanelBottom className={icon} />, title: "Una status line", body: "La cuenta, su uso de 5 h y semanal, el contexto, la rama y el costo, debajo del prompt de Claude Code.", href: "/docs/concepts/profiles#the-status-line" },
      { icon: <Globe className={icon} />, title: "Un navegador con perfiles reales", body: "turno-browser maneja el Chrome que tienes instalado, con un perfil persistente por identidad.", href: "/docs/guides/signed-in-browser" },
    ],
    agentsTitle: "Cuatro agentes, una configuración",
    agentsLead: "Un perfil es una carpeta y un lanzador. El agente es la CLI oficial del proveedor, sin modificar.",
    agentsHead: ["Agente", "Perfil y lanzador", "Ejemplo"],
    agentsMore: "opencode, Gemini CLI, Goose, Crush, Droid y Kiro también pueden usar el gateway.",
    guidesTitle: "Empieza por tu problema",
    guides: [
      ["Tengo cuentas de trabajo y personales", "/docs/guides/work-and-personal"],
      ["Muchas sesiones se comen mi RAM", "/docs/guides/many-sessions-ram"],
      ["Uso Claude Code y Codex", "/docs/guides/claude-code-and-codex"],
      ["Que un agente use mi navegador con sesión iniciada", "/docs/guides/signed-in-browser"],
    ],
    privacyTitle: "Nada sale de tu máquina",
    privacy: "No hay cuenta, ni telemetría, ni proxy del tráfico con el modelo. turno nunca lee, guarda ni reenvía tus tokens de sesión: cada agente inicia sesión por su cuenta, en su propia carpeta. Cada cuenta sigue sujeta a los términos de su proveedor.",
    privacyLink: "Seguridad y privacidad",
    footer: "turno es un proyecto independiente de código abierto. No está afiliado, respaldado ni patrocinado por ningún proveedor de las herramientas con las que funciona. Hecho en Monterrey, México.",
  },
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t px-6 py-14 md:px-10">
      <h2 className="mb-8 font-mono text-xs uppercase tracking-widest text-fd-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

export default async function HomePage({ params }: PageProps<"/[lang]">) {
  const { lang } = await params;
  const t = COPY[lang] ?? COPY.en!;
  const to = (path: string) => localePath(lang, path);
  return (
    <main className="mx-auto w-full max-w-[1100px] flex-1 border-x">
      <section className="relative overflow-hidden px-6 pb-16 pt-16 md:px-10 md:pt-24">
        <div className="home-grid pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative">
          <p className="mb-6 font-mono text-xs uppercase tracking-widest text-fd-muted-foreground">{t.eyebrow}</p>
          <h1 className="max-w-3xl text-4xl font-semibold leading-[1.05] tracking-tight md:text-6xl">{t.title}</h1>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-fd-muted-foreground md:text-lg">{t.lead}</p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href={to("/docs")} className="inline-flex items-center gap-2 rounded-full bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90">
              {t.start} <ArrowRight className="size-4" />
            </Link>
            <a href={REPO} rel="noreferrer noopener" className="inline-flex items-center rounded-full border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent">
              GitHub
            </a>
          </div>
          <div className="mt-10 max-w-xl">
            <p className="mb-2 text-sm font-medium">{t.tryIt}</p>
            <pre className="overflow-x-auto rounded-lg border bg-fd-card px-4 py-3 font-mono text-sm">
              <code>
                <span className="select-none text-fd-muted-foreground">$ </span>npx turno-cli demo
              </code>
            </pre>
            <p className="mt-2 text-sm text-fd-muted-foreground">{t.tryNote}</p>
          </div>
        </div>
      </section>

      <section className="border-t">
        <div className="grid divide-y md:grid-cols-3 md:divide-x md:divide-y-0">
          {t.numbers.map(([value, label], i) => (
            <div key={value} className="px-6 py-8 md:px-10">
              <p className={`font-mono text-3xl font-semibold tracking-tight md:text-4xl ${i === 0 ? "text-fd-muted-foreground" : "text-fd-primary"}`}>{value}</p>
              <p className="mt-2 text-sm text-fd-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
        <div className="border-t px-6 py-6 md:px-10">
          <GatewayDiagram lang={lang} />
          <p className="text-sm text-fd-muted-foreground">
            {t.numbersNote}{" "}
            <Link href={to("/docs/benchmarks")} className="font-medium text-fd-foreground underline underline-offset-4">
              {t.benchmark}
            </Link>
          </p>
        </div>
      </section>

      <Section title={t.whatTitle}>
        <div className="grid gap-px overflow-hidden rounded-xl border bg-fd-border sm:grid-cols-2 lg:grid-cols-3">
          {t.features.map((f) => (
            <Link key={f.title} href={to(f.href)} className="group flex flex-col gap-3 bg-fd-background p-6 transition-colors hover:bg-fd-accent/50">
              {f.icon}
              <h3 className="font-medium">{f.title}</h3>
              <p className="text-sm leading-relaxed text-fd-muted-foreground">{f.body}</p>
            </Link>
          ))}
          <div className="hidden bg-fd-background lg:block" aria-hidden />
        </div>
      </Section>

      <Section title={t.guidesTitle}>
        <ul className="grid gap-px overflow-hidden rounded-xl border bg-fd-border sm:grid-cols-2">
          {t.guides.map(([label, href]) => (
            <li key={href} className="bg-fd-background">
              <Link href={to(href)} className="flex items-center justify-between gap-4 p-5 text-sm font-medium transition-colors hover:bg-fd-accent/50">
                {label} <ArrowRight className="size-4 shrink-0 text-fd-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t.agentsTitle}>
        <p className="mb-6 max-w-2xl text-sm text-fd-muted-foreground">{t.agentsLead}</p>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="bg-fd-card font-mono text-xs uppercase tracking-wider text-fd-muted-foreground">
              <tr>
                {t.agentsHead.map((h) => (
                  <th key={h} className="px-5 py-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {AGENTS.map(([agent, profile, example]) => (
                <tr key={agent}>
                  <td className="px-5 py-3 font-medium">{agent}</td>
                  <td className="px-5 py-3 font-mono text-xs text-fd-muted-foreground">{profile}</td>
                  <td className="px-5 py-3 font-mono text-xs">{example}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-sm text-fd-muted-foreground">{t.agentsMore}</p>
      </Section>

      <Section title={t.privacyTitle}>
        <p className="max-w-2xl text-base leading-relaxed">{t.privacy}</p>
        <Link href={to("/docs/security")} className="mt-4 inline-flex items-center gap-2 text-sm font-medium underline underline-offset-4">
          {t.privacyLink} <ArrowRight className="size-4" />
        </Link>
      </Section>

      <footer className="border-t px-6 py-8 text-xs leading-relaxed text-fd-muted-foreground md:px-10">{t.footer}</footer>
    </main>
  );
}
