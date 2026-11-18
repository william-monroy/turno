/**
 * The words of the landing page, in English and Spanish: headlines, leads, commands and the
 * rail. A scene keeps the few labels that only it draws next to its own code.
 */

/** In story order: the conversation that survives the switch comes first, the folder rule (how turno picks the account) later. */
export const SECTION_IDS = ["hero", "context", "logins", "browser", "skills", "accounts", "gateway", "agents", "start"] as const;
export type SectionId = (typeof SECTION_IDS)[number];
export type StoryId = Exclude<SectionId, "hero">;
export type Lang = "en" | "es";

/** A headline in three parts: plain text, the words that carry the idea, plain text. */
export type Headline = [before: string, mark: string, after: string];

export interface Command {
  /** The command as typed. */
  run: string;
  /** What it does, in one line. */
  note: string;
}

export interface SectionCopy {
  /** The short name on the rail. */
  tab: string;
  /** The label over the headline. */
  label: string;
  headline: Headline;
  lead: string;
  commands: Command[];
  /** A caveat under the commands, when the section needs one. */
  aside?: string;
  /** The link to the documentation page that goes deeper. */
  more: { text: string; href: string };
  /** What the rail says before the scene reports anything. */
  rest: string;
}

export interface LandingCopy {
  hero: {
    tab: string;
    eyebrow: string;
    headline: Headline;
    /** The line under the headline: the moment the page is about. */
    hook: string;
    lead: string;
    demoLabel: string;
    demoNote: string;
    docs: string;
    rest: string;
  };
  pains: { title: string; items: { text: string; to: StoryId }[] };
  sections: Record<StoryId, SectionCopy>;
  rail: { label: string; previous: string; next: string; copy: string; copied: string };
  footer: { disclaimer: string; madeBy: string; site: string };
}

const en: LandingCopy = {
  hero: {
    tab: "hero",
    eyebrow: "Open source · Apache-2.0 · macOS and Linux",
    headline: ["Switch accounts. Keep ", "everything else", "."],
    hook: "Switching accounts? Keep talking.",
    lead: "The same session continues on your other account, with all its context, its MCP servers already signed in and its browser still logged in.",
    demoLabel: "Try the demo",
    demoNote: "Runs in a throwaway HOME. Your own setup is not touched.",
    docs: "Read the docs",
    rest: "one conversation, two accounts",
  },
  pains: {
    title: "Start from your problem",
    items: [
      { text: "I have work and personal accounts", to: "context" },
      { text: "I sign in to every MCP server again and again", to: "logins" },
      { text: "My agent opens a browser that is not signed in", to: "browser" },
      { text: "Many sessions eat my RAM", to: "gateway" },
    ],
  },
  sections: {
    accounts: {
      tab: "folders",
      label: "how it knows which account",
      headline: ["Every project folder has its own ", "account", "."],
      lead: "This is how turno knows which account to use. Assign a folder once and every agent you open there signs in with that account. Folders without a rule use your default.",
      commands: [
        { run: "turno profile assign ~/code/acme work", note: "This folder and everything under it." },
        { run: "turno auto", note: "Opens the agent with this folder's account. It never switches accounts in silence." },
      ],
      more: { text: "Folder rules", href: "/docs/concepts/folder-rules" },
      rest: "pick a folder",
    },
    context: {
      tab: "conversation",
      label: "the conversation keeps going",
      headline: ["Change account. The ", "conversation", " comes along."],
      lead: "Your Claude Code profiles share conversations, skills and settings. A session started with one account continues with another, or forks so both keep going.",
      commands: [
        { run: "turno work --resume <id>", note: "Continue a session that another account started." },
        { run: "turno session handoff work", note: "Prints the exact command to continue this session under another profile." },
        { run: "turno session handoff work --fork", note: "Keeps this session open and starts a copy under the other profile." },
      ],
      more: { text: "What profiles share", href: "/docs/concepts/profiles" },
      rest: "one conversation, kept by every profile",
    },
    logins: {
      tab: "logins",
      label: "MCP logins, once per account",
      headline: ["One login per account. ", "Every agent", " uses it."],
      lead: "The gateway signs in to each remote MCP server once per account and keeps the token in your keychain. No agent logs in on its own, and each profile reaches its own account of the same service.",
      commands: [
        { run: "turno mcp login linear", note: "One OAuth login, shared by every session of every agent on that account." },
        { run: "[server.issues.variant.work]", note: "A variant per profile: work and personal reach different accounts of one service." },
        { run: "turno secret set", note: "Secrets live in the macOS Keychain or the Linux Secret Service, not in agent configs." },
      ],
      more: { text: "One server, two accounts", href: "/docs/concepts/gateway" },
      rest: "no agent has signed in yet",
    },
    browser: {
      tab: "browser",
      label: "a browser per identity",
      headline: ["A browser that is already the ", "right you", "."],
      lead: "Each identity gets its own real Chrome profile. You sign in by hand once and the cookies stay. Links open with the account that owns them, and an agent works inside sessions you already have.",
      commands: [
        { run: "turno open work <url>", note: "The link opens in that profile's Chrome profile." },
        { run: "turno identity add browser:school", note: "A new identity with its own persistent profile, and its entry in the gateway." },
        { run: "turno identity login browser:school", note: "Sign in by hand once. Cookies persist." },
      ],
      aside: "A separate package, turno-browser. For your own accounts, at a human pace.",
      more: { text: "Browser identities", href: "/docs/concepts/browser-identities" },
      rest: "three identities, three Chrome profiles",
    },
    skills: {
      tab: "skills",
      label: "skills between accounts",
      headline: ["Move work ", "between accounts", " from inside the session."],
      lead: "A Claude Code plugin adds the moves you repeat every day. Each skill hands you the exact command or does the copy for you. Nothing switches behind your back.",
      commands: [
        { run: "/switch-account work", note: "Continue this session under another profile, with the conversation intact." },
        { run: "/fork-session personal", note: "Open a copy of this session under another profile and keep this one going." },
        { run: "/copy-artifact", note: "Copy a claude.ai artifact, with its files and assets, to another account." },
      ],
      aside: "Install it with /plugin marketplace add wimo-dev/turno and /plugin install turno@turno.",
      more: { text: "The skills, one by one", href: "/docs/concepts/skills" },
      rest: "three skills and a bridge",
    },
    gateway: {
      tab: "gateway",
      label: "one shared gateway",
      headline: ["Eight sessions. ", "One", " set of servers."],
      lead: "Every agent session starts its own copy of every MCP server. turno starts each server once, only when a tool is called, shares it between sessions and stops it when idle.",
      commands: [
        { run: "turno mcp top", note: "Memory per server, as it runs." },
        { run: "turno mcp savings", note: "What the gateway saves on your own machine." },
        { run: "turno mcp log", note: "Every tool call that went through it." },
      ],
      aside: "Measured on an Apple M3 with 16 GB, 2026-11-16, six common servers. Reproduce it with node bench/mcp-ram.mjs before you quote a number.",
      more: { text: "Method and caveats", href: "/docs/benchmarks" },
      rest: "8 sessions, 6 servers each",
    },
    agents: {
      tab: "agents",
      label: "works with your agents",
      headline: ["Four agents. ", "One", " setup."],
      lead: "The same profiles, folder rules and gateway work for every agent you use. In Claude Code, a status line shows which account you are on and how much of it is left.",
      commands: [
        { run: "turno profile add cx --agent codex", note: "A profile for another agent, with the same rules." },
        { run: "turno mcp config --agent <name>", note: "Gateway entries for opencode, Gemini CLI, Goose, Crush, Droid and Kiro." },
        { run: "turno ui install", note: "The status line, its font and icons." },
      ],
      more: { text: "Claude Code and Codex", href: "/docs/guides/claude-code-and-codex" },
      rest: "four agents, the same rules",
    },
    start: {
      tab: "start",
      label: "safe to try",
      headline: ["Try it without touching ", "your setup", "."],
      lead: "The demo runs in a throwaway HOME. When you install for real, turno asks before it adopts anything and writes it all as one change you can undo.",
      commands: [
        { run: "npx turno-cli demo", note: "The whole tour in a throwaway HOME." },
        { run: "turno undo", note: "Every write can be put back." },
        { run: "turno uninstall --dry-run", note: "Lists everything turno set up before removing it. Your profile folders stay." },
      ],
      aside: "turno runs each vendor's own CLI, unmodified. It is for separate work and personal accounts, not for getting around limits.",
      more: { text: "Try it", href: "/docs/get-started/try-it" },
      rest: "nothing leaves your machine",
    },
  },
  rail: { label: "Sections", previous: "Previous section", next: "Next section", copy: "Copy", copied: "Copied" },
  footer: {
    disclaimer:
      "turno is an independent open-source project. It is not affiliated with, endorsed by or sponsored by any vendor of the tools it works with.",
    madeBy: "Made by",
    site: "wimodev",
  },
};

const es: LandingCopy = {
  hero: {
    tab: "inicio",
    eyebrow: "Código abierto · Apache-2.0 · macOS y Linux",
    headline: ["Cambia de cuenta. Conserva ", "todo lo demás", "."],
    hook: "¿Cambias de cuenta? La conversación sigue.",
    lead: "La misma sesión continúa en tu otra cuenta, con todo su contexto, sus servidores MCP ya con sesión iniciada y su navegador todavía con la sesión abierta.",
    demoLabel: "Prueba la demo",
    demoNote: "Corre en un HOME desechable. No toca tu configuración.",
    docs: "Leer la documentación",
    rest: "una conversación, dos cuentas",
  },
  pains: {
    title: "Empieza por tu problema",
    items: [
      { text: "Tengo cuentas de trabajo y personales", to: "context" },
      { text: "Inicio sesión en cada servidor MCP una y otra vez", to: "logins" },
      { text: "Mi agente abre un navegador sin mi sesión", to: "browser" },
      { text: "Muchas sesiones se comen mi RAM", to: "gateway" },
    ],
  },
  sections: {
    accounts: {
      tab: "carpetas",
      label: "cómo sabe qué cuenta usar",
      headline: ["Cada carpeta de proyecto tiene su ", "cuenta", "."],
      lead: "Así sabe turno qué cuenta usar. Asigna una carpeta una sola vez y cada agente que abras ahí entra con esa cuenta. Las carpetas sin regla usan tu cuenta por defecto.",
      commands: [
        { run: "turno profile assign ~/code/acme work", note: "Esta carpeta y todo lo que contiene." },
        { run: "turno auto", note: "Abre el agente con la cuenta de esta carpeta. Nunca cambia de cuenta sin avisar." },
      ],
      more: { text: "Reglas de carpeta", href: "/docs/concepts/folder-rules" },
      rest: "elige una carpeta",
    },
    context: {
      tab: "conversación",
      label: "la conversación sigue",
      headline: ["Cambia de cuenta. La ", "conversación", " va contigo."],
      lead: "Tus perfiles de Claude Code comparten conversaciones, skills y ajustes. Una sesión que empezó con una cuenta continúa con otra, o se bifurca para que las dos sigan.",
      commands: [
        { run: "turno work --resume <id>", note: "Continúa una sesión que empezó otra cuenta." },
        { run: "turno session handoff work", note: "Imprime el comando exacto para continuar esta sesión con otro perfil." },
        { run: "turno session handoff work --fork", note: "Deja esta sesión abierta y empieza una copia con el otro perfil." },
      ],
      more: { text: "Qué comparten los perfiles", href: "/docs/concepts/profiles" },
      rest: "una conversación, la conservan todos los perfiles",
    },
    logins: {
      tab: "sesiones",
      label: "una sesión de MCP por cuenta",
      headline: ["Una sesión por cuenta. ", "Todos los agentes", " la usan."],
      lead: "El gateway inicia sesión en cada servidor MCP remoto una vez por cuenta y guarda el token en tu llavero. Ningún agente inicia sesión por su lado, y cada perfil llega a su propia cuenta del mismo servicio.",
      commands: [
        { run: "turno mcp login linear", note: "Un solo inicio de sesión OAuth, compartido por todas las sesiones de todos los agentes de esa cuenta." },
        { run: "[server.issues.variant.work]", note: "Una variante por perfil: trabajo y personal llegan a cuentas distintas del mismo servicio." },
        { run: "turno secret set", note: "Los secretos viven en el llavero de macOS o en el Secret Service de Linux, no en la configuración de los agentes." },
      ],
      more: { text: "Un servidor, dos cuentas", href: "/docs/concepts/gateway" },
      rest: "ningún agente ha iniciado sesión todavía",
    },
    browser: {
      tab: "navegador",
      label: "un navegador por identidad",
      headline: ["Un navegador que ya es tu ", "cuenta correcta", "."],
      lead: "Cada identidad tiene su propio perfil real de Chrome. Inicias sesión a mano una vez y las cookies se quedan. Los enlaces se abren con la cuenta a la que pertenecen, y un agente trabaja dentro de las sesiones que ya tienes.",
      commands: [
        { run: "turno open work <url>", note: "El enlace se abre en el perfil de Chrome de ese perfil." },
        { run: "turno identity add browser:school", note: "Una identidad nueva con su perfil persistente y su entrada en el gateway." },
        { run: "turno identity login browser:school", note: "Inicia sesión a mano una vez. Las cookies se conservan." },
      ],
      aside: "Es un paquete aparte, turno-browser. Para tus propias cuentas, a ritmo humano.",
      more: { text: "Identidades del navegador", href: "/docs/concepts/browser-identities" },
      rest: "tres identidades, tres perfiles de Chrome",
    },
    skills: {
      tab: "skills",
      label: "skills entre cuentas",
      headline: ["Mueve el trabajo ", "entre cuentas", " sin salir de la sesión."],
      lead: "Un plugin de Claude Code agrega los movimientos que repites todos los días. Cada skill te da el comando exacto o hace la copia por ti. Nada cambia a tus espaldas.",
      commands: [
        { run: "/switch-account work", note: "Continúa esta sesión con otro perfil, con la conversación intacta." },
        { run: "/fork-session personal", note: "Abre una copia de esta sesión con otro perfil y deja esta abierta." },
        { run: "/copy-artifact", note: "Copia un artifact de claude.ai, con sus archivos y recursos, a otra cuenta." },
      ],
      aside: "Se instala con /plugin marketplace add wimo-dev/turno y /plugin install turno@turno.",
      more: { text: "Las skills, una por una", href: "/docs/concepts/skills" },
      rest: "tres skills y un puente",
    },
    gateway: {
      tab: "gateway",
      label: "un gateway compartido",
      headline: ["Ocho sesiones. ", "Un solo", " juego de servidores."],
      lead: "Cada sesión de un agente arranca su propia copia de cada servidor MCP. turno arranca cada servidor una vez, solo cuando se llama una herramienta, lo comparte entre sesiones y lo detiene cuando queda inactivo.",
      commands: [
        { run: "turno mcp top", note: "La memoria de cada servidor, mientras corre." },
        { run: "turno mcp savings", note: "Lo que ahorra el gateway en tu propia máquina." },
        { run: "turno mcp log", note: "Cada llamada a una herramienta que pasó por él." },
      ],
      aside: "Medido en un Apple M3 con 16 GB, el 2026-11-16, con seis servidores comunes. Reprodúcelo con node bench/mcp-ram.mjs antes de citar un número.",
      more: { text: "Método y salvedades", href: "/docs/benchmarks" },
      rest: "8 sesiones, 6 servidores cada una",
    },
    agents: {
      tab: "agentes",
      label: "funciona con tus agentes",
      headline: ["Cuatro agentes. ", "Una sola", " configuración."],
      lead: "Los mismos perfiles, reglas de carpeta y gateway sirven para todos los agentes que usas. En Claude Code, una status line muestra en qué cuenta estás y cuánto le queda.",
      commands: [
        { run: "turno profile add cx --agent codex", note: "Un perfil para otro agente, con las mismas reglas." },
        { run: "turno mcp config --agent <name>", note: "Entradas del gateway para opencode, Gemini CLI, Goose, Crush, Droid y Kiro." },
        { run: "turno ui install", note: "La status line, su fuente y sus iconos." },
      ],
      more: { text: "Claude Code y Codex", href: "/docs/guides/claude-code-and-codex" },
      rest: "cuatro agentes, las mismas reglas",
    },
    start: {
      tab: "empezar",
      label: "seguro de probar",
      headline: ["Pruébalo sin tocar ", "tu configuración", "."],
      lead: "La demo corre en un HOME desechable. Cuando lo instalas de verdad, turno pregunta antes de adoptar algo y lo escribe todo como un solo cambio que puedes deshacer.",
      commands: [
        { run: "npx turno-cli demo", note: "El recorrido completo en un HOME desechable." },
        { run: "turno undo", note: "Cada escritura se puede revertir." },
        { run: "turno uninstall --dry-run", note: "Lista todo lo que turno configuró antes de quitarlo. Tus carpetas de perfil se quedan." },
      ],
      aside: "turno corre la CLI oficial de cada proveedor, sin modificar. Es para separar cuentas de trabajo y personales, no para saltarse límites.",
      more: { text: "Pruébalo", href: "/docs/get-started/try-it" },
      rest: "nada sale de tu máquina",
    },
  },
  rail: { label: "Secciones", previous: "Sección anterior", next: "Sección siguiente", copy: "Copiar", copied: "Copiado" },
  footer: {
    disclaimer:
      "turno es un proyecto independiente de código abierto. No está afiliado, respaldado ni patrocinado por ningún proveedor de las herramientas con las que funciona.",
    madeBy: "Hecho por",
    site: "wimodev",
  },
};

const COPY: Record<Lang, LandingCopy> = { en, es };

export function landingCopy(lang: string): LandingCopy {
  return lang === "es" ? COPY.es : COPY.en;
}

export function asLang(lang: string): Lang {
  return lang === "es" ? "es" : "en";
}
