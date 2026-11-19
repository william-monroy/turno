import type { Headline, Lang, SectionCopy } from "../landing/copy";
import type { ChapterCommand } from "../landing/chapters/section";

/*
 * The words of the turno-browser page (/browser), in English and Spanish, and every command it
 * shows. Commands and the lines a tool prints are the same in both languages, so they live in
 * CMD and PRINTS: check each against `turno-browser --help` and the package's source before the
 * page ships.
 */

/** Every command on the page, as typed. */
export const CMD = {
  install: "npm install --global turno-browser",
  add: "turno-browser add school",
  login: "turno-browser login school",
  set: "turno-browser set school --tabs-max 12 --tabs-park 10m",
  vaultAdd: "turno-browser vault add school campus --url https://campus.example.edu/login --username me --totp",
  /** The same command as it reads under the picture, where the whole line does not fit. */
  vaultAddShort: "turno-browser vault add school campus ...",
  export: "turno-browser export school --out school.session",
  sharing: "turno-browser set school --sharing tabs",
  replay: "turno-browser replay school sign-in",
  live: "turno-browser live school",
  setup: "turno-browser setup claude",
  withTurnoInstall: "npm install --global turno-cli turno-browser",
  withTurnoAdd: "turno identity add browser:school",
} as const;

/** The tools an agent calls, by their MCP names. */
export const TOOL = {
  navigate: "browser_navigate",
  tabs: "browser_tabs",
  login: "browser_login",
} as const;

/** Where an identity lives on disk, and the site the examples sign in to. */
export const IDENTITY_PATH = "~/.local/share/turno/browser/identities/school";
export const SITE = "campus.example.edu";

/** What the commands and tools print, word for word. */
export const PRINTS = {
  added: `identity "school" ready at ${IDENTITY_PATH}`,
  opening: `Opening Chrome for identity "school". Sign in to your sites, then close the window to save the session.`,
  capped: "closed the least recently used tab (https://docs.example.com/guide): more than 8 were open",
  parked: "parked a tab unused for 5 minutes on about:blank (https://docs.example.com/api); using it again loads that page",
  closed: "closed a tab unused for 15 minutes (https://docs.example.com/api)",
  filled: `Filled the username, password and one-time code of "campus" from the vault of identity "school" on https://${SITE}. The values are hidden as [vault: ...] in every result.`,
  notSubmitted: "Nothing was submitted: click the sign-in button yourself (it is in the snapshot below).",
} as const;

export const CHAPTER_IDS = ["identities", "tabs", "vault"] as const;
export type ChapterId = (typeof CHAPTER_IDS)[number];

/** A chapter of this page: the home page's section, with commands that say how each is entered. */
export interface BrowserChapter extends SectionCopy {
  commands: ChapterCommand[];
}

export interface Card {
  title: string;
  text: string;
  run: string;
  more: { text: string; href: string };
}

export interface Path {
  title: string;
  text: string;
  commands: { run: string; note: string }[];
  more?: { text: string; href: string };
}

export interface BrowserCopy {
  hero: {
    eyebrow: string;
    headline: Headline;
    /** The second sentence of the line, under the headline. */
    hook: string;
    lead: string;
    docs: string;
    figure: string;
  };
  pains: { title: string; items: { text: string; to: ChapterId }[] };
  chapters: Record<ChapterId, BrowserChapter>;
  pictures: {
    list: string;
    identities: {
      figure: string;
      you: string;
      agent: string;
      onDisk: string;
      none: string;
      notYet: string;
      byHand: string;
      signedIn: string;
      kept: string;
      saved: string;
      arrived: string;
      page: string;
    };
    tabs: {
      figure: string;
      cap: string;
      current: string;
      running: string;
      parked: string;
      later5: string;
      later15: string;
      chromeClosed: string;
      onDisk: string;
      again: string;
      written: string;
      idle: string;
    };
    vault: {
      figure: string;
      keychain: string;
      page: string;
      model: string;
      nothing: string;
      hidden: string;
      username: string;
      password: string;
      code: string;
      stored: string;
      signIn: string;
      notPart: string;
    };
  };
  more: { label: string; headline: Headline; cards: Card[] };
  layers: {
    label: string;
    headline: Headline;
    lead: string;
    figure: string;
    rows: { name: string; items: string[] }[];
    beside: string;
    more: { text: string; href: string };
  };
  setup: { label: string; headline: Headline; alone: Path; withTurno: Path };
  use: { label: string; text: string; more: { text: string; href: string } };
  start: { label: string; headline: Headline; text: string; docs: string; home: string };
}

const DOCS = "/docs/concepts/browser-identities";

const en: BrowserCopy = {
  hero: {
    eyebrow: "turno-browser · Open source · Apache-2.0 · macOS and Linux",
    headline: ["A browser your agents use with ", "your accounts", "."],
    hook: "It stays light on your machine, and the model never sees your passwords.",
    lead: "An MCP server for Claude Code, Codex, Copilot CLI and Cursor CLI. It drives the Google Chrome you already have, with one persistent profile per identity.",
    docs: "Read the docs",
    figure: "A Chrome window of the identity school: signed in, with two pages running and three parked, and a password field whose value is hidden.",
  },
  pains: {
    title: "Start from your problem",
    items: [
      { text: "My agent opens a browser that is not signed in", to: "identities" },
      { text: "A browser left open eats my machine", to: "tabs" },
      { text: "I do not want a model to see my passwords", to: "vault" },
    ],
  },
  chapters: {
    identities: {
      tab: "identities",
      label: "one profile per identity",
      headline: ["Signed in ", "before the agent arrives", "."],
      lead: "Each identity is a real Chrome profile on your machine. You sign in by hand once and the cookies stay there. The agent opens that same browser afterwards and starts where you left off.",
      commands: [
        { prompt: "$", run: CMD.add, note: "A new identity with its own persistent Chrome profile." },
        { prompt: "$", run: CMD.login, note: "Opens its Chrome. Sign in by hand once, then close the window." },
        { prompt: "tool", run: TOOL.navigate, note: "The agent opens the site in that profile, already signed in.", copyable: false },
      ],
      aside: "The profile holds live cookies. Treat its folder as credentials.",
      more: { text: "Browser identities", href: DOCS },
      rest: "no identity yet",
    },
    tabs: {
      tab: "tabs",
      label: "a browser that cleans up",
      headline: ["Left open for hours, it ", "stays light", "."],
      lead: "An agent that browses for an hour leaves dozens of pages behind. turno-browser caps them, parks the ones nobody uses and closes Chrome when no agent is calling it. The next call opens it again with the same profile.",
      commands: [
        { prompt: "tool", run: TOOL.tabs, note: "The agent opens a ninth page. The least recently used one closes, never its current tab.", copyable: false },
        { prompt: "…", run: "5 minutes unused", note: "A page nobody uses goes to a blank page and stops running. It loads again when the agent needs it.", copyable: false },
        { prompt: "…", run: "15 minutes without a call", note: "Chrome closes. The next call opens it again, with the same profile and cookies.", copyable: false },
        { prompt: "$", run: CMD.set, note: "Every limit is a setting of the identity." },
      ],
      aside: "By default: 8 pages, parked after 5 minutes, closed after 15.",
      more: { text: "Tabs and lifecycle", href: `${DOCS}#tabs` },
      rest: "eight pages open",
    },
    vault: {
      tab: "vault",
      label: "passwords stay out of the model",
      headline: ["The model ", "never sees", " your passwords."],
      lead: "An identity can keep a username, a password and a one-time code secret per site in your system keychain. The agent asks to sign in by the site's name. The tool fills the form, only on that site's own addresses, and hides the values from every later result.",
      commands: [
        { prompt: "$", run: CMD.vaultAdd, note: "The password and the one-time secret are asked with hidden prompts." },
        { prompt: "tool", run: TOOL.login, note: "The agent names the site. The tool fills the username, the password and the current code.", copyable: false },
      ],
      aside: "It does not submit the form unless you turn that on for the identity.",
      more: { text: "Credential vault", href: `${DOCS}#credential-vault` },
      rest: "nothing stored yet",
    },
  },
  pictures: {
    list: "Steps: choose one to run it in the picture",
    identities: {
      figure: "The Chrome profile of the identity school, first empty, then signed in by hand, then opened by an agent. Choose a step to run it here.",
      you: "you",
      agent: "agent",
      onDisk: "profile on disk",
      none: "no identity yet",
      notYet: "not signed in yet",
      byHand: "you sign in by hand",
      signedIn: "signed in",
      kept: "cookies kept",
      saved: "window closed, session saved in the profile",
      arrived: "the page opens signed in: the cookies were already in the profile",
      page: "My courses",
    },
    tabs: {
      figure: "The pages open in one identity's Chrome, and what happens to them over time. Choose a step to run it here.",
      cap: "at most",
      current: "the agent's tab",
      running: "running",
      parked: "parked",
      later5: "5 min later",
      later15: "15 min later",
      chromeClosed: "Chrome closed",
      onDisk: "profile and cookies on disk",
      again: "the next call opens Chrome again with the same profile, still signed in",
      written: "written to the identity's settings: at most 12 pages, parked after 10 minutes",
      idle: "15 minutes without a tool call: Chrome closes",
    },
    vault: {
      figure: "A sign-in page, the system keychain that holds its credentials, and what the model sees. Choose a step to run it here.",
      keychain: "system keychain",
      page: "the page",
      model: "what the model sees",
      nothing: "nothing yet",
      hidden: "hidden",
      username: "username",
      password: "password",
      code: "one-time code",
      stored: "kept in the system keychain, never in a file",
      signIn: "Sign in",
      notPart: "The model is not part of this step.",
    },
  },
  more: {
    label: "also in the box",
    headline: ["What else comes ", "with it", "."],
    cards: [
      {
        title: "Take a signed-in session to another machine",
        text: "Cookies, localStorage and IndexedDB in one file, encrypted with a passphrase you type. It expires, and it never holds vault credentials.",
        run: CMD.export,
        more: { text: "Moving a session", href: `${DOCS}#moving-a-session` },
      },
      {
        title: "Several agents, one browser",
        text: "Several agent sessions use one identity's Chrome at once, each in its own tabs. Off until you turn it on.",
        run: CMD.sharing,
        more: { text: "Sharing a browser", href: `${DOCS}#several-agents-one-browser` },
      },
      {
        title: "Record once, replay later",
        text: "An agent saves what it did on a site as a flow and runs it again later without working the page out.",
        run: CMD.replay,
        more: { text: "Flows", href: `${DOCS}#flows-record-and-replay` },
      },
      {
        title: "Watch, and take the controls",
        text: "See what the agent does in the browser, pause it, and take over when a page needs you.",
        run: CMD.live,
        more: { text: "Live view", href: `${DOCS}#live-view-and-take-over` },
      },
    ],
  },
  layers: {
    label: "where it sits",
    headline: ["The layer ", "above the driver", "."],
    lead: "A driver moves the browser. turno-browser decides which browser that is, whose session it carries, how long it stays open and what the model gets to see. It works next to browser-use, Stagehand and Browserbase, with Playwright underneath.",
    figure: "Four layers, top to bottom: your agents, turno-browser, the driver and your Chrome.",
    rows: [
      { name: "your agents", items: ["Claude Code", "Codex", "Copilot CLI", "Cursor CLI"] },
      { name: "turno-browser", items: ["identities", "vault", "tabs and lifecycle", "portable sessions", "shared tabs", "record and replay", "live view"] },
      { name: "the driver", items: ["Playwright"] },
      { name: "the browser", items: ["your Google Chrome"] },
    ],
    beside: "Each agent reaches it over MCP.",
    more: { text: "How it compares", href: "/docs/browser-alternatives" },
  },
  setup: {
    label: "two ways in",
    headline: ["On its own, or ", "with turno", "."],
    alone: {
      title: "On its own",
      text: "turno-browser is its own package. Install it, add an identity and point your agent at it.",
      commands: [
        { run: CMD.install, note: "The package and its command." },
        { run: CMD.add, note: "Your first identity." },
        { run: CMD.setup, note: "Prints the MCP entry for your agent." },
      ],
    },
    withTurno: {
      title: "With turno",
      text: "turno's gateway runs one browser server for every session of every agent, and stops it when nobody uses it.",
      commands: [
        { run: CMD.withTurnoInstall, note: "Both packages." },
        { run: CMD.withTurnoAdd, note: "The identity and its entry in the gateway." },
      ],
      more: { text: "What turno does", href: "/" },
    },
  },
  use: {
    label: "acceptable use",
    text: "Use it with your own accounts, on sites whose terms allow automated access by you, and at a human pace. Do not use it to get around access controls, paywalls or rate limits, to scrape at scale, or to access accounts that are not yours.",
    more: { text: "Read the full note", href: `${DOCS}#acceptable-use` },
  },
  start: {
    label: "start",
    headline: ["Set it up ", "in one command", "."],
    text: "Install it, add an identity and sign in once. The docs take it from there.",
    docs: "Read the docs",
    home: "See turno",
  },
};

const es: BrowserCopy = {
  hero: {
    eyebrow: "turno-browser · Código abierto · Apache-2.0 · macOS y Linux",
    headline: ["Un navegador que tus agentes usan con ", "tus cuentas", "."],
    hook: "No carga tu máquina, y el modelo nunca ve tus contraseñas.",
    lead: "Un servidor MCP para Claude Code, Codex, Copilot CLI y Cursor CLI. Maneja el Google Chrome que ya tienes, con un perfil persistente por identidad.",
    docs: "Leer la documentación",
    figure: "Una ventana de Chrome de la identidad school: con sesión iniciada, dos páginas activas y tres en pausa, y un campo de contraseña con el valor oculto.",
  },
  pains: {
    title: "Empieza por tu problema",
    items: [
      { text: "Mi agente abre un navegador sin mi sesión", to: "identities" },
      { text: "Un navegador abierto se come mi máquina", to: "tabs" },
      { text: "No quiero que un modelo vea mis contraseñas", to: "vault" },
    ],
  },
  chapters: {
    identities: {
      tab: "identidades",
      label: "un perfil por identidad",
      headline: ["Con la sesión iniciada ", "antes de que llegue el agente", "."],
      lead: "Cada identidad es un perfil real de Chrome en tu máquina. Inicias sesión a mano una vez y las cookies se quedan ahí. Después el agente abre ese mismo navegador y sigue donde lo dejaste.",
      commands: [
        { prompt: "$", run: CMD.add, note: "Una identidad nueva con su propio perfil persistente de Chrome." },
        { prompt: "$", run: CMD.login, note: "Abre su Chrome. Inicia sesión a mano una vez y cierra la ventana." },
        { prompt: "tool", run: TOOL.navigate, note: "El agente abre el sitio en ese perfil, con la sesión ya iniciada.", copyable: false },
      ],
      aside: "El perfil guarda cookies vivas. Trata su carpeta como credenciales.",
      more: { text: "Identidades del navegador", href: DOCS },
      rest: "todavía no hay identidades",
    },
    tabs: {
      tab: "pestañas",
      label: "un navegador que limpia solo",
      headline: ["Abierto por horas, ", "sigue ligero", "."],
      lead: "Un agente que navega una hora deja decenas de páginas abiertas. turno-browser les pone un tope, pausa las que nadie usa y cierra Chrome cuando ningún agente lo llama. La siguiente llamada lo abre otra vez con el mismo perfil.",
      commands: [
        { prompt: "tool", run: TOOL.tabs, note: "El agente abre una novena página. Se cierra la que lleva más tiempo sin usarse, nunca su pestaña actual.", copyable: false },
        { prompt: "…", run: "5 minutos sin uso", note: "Una página que nadie usa pasa a una página en blanco y deja de correr. Se carga de nuevo cuando el agente la necesita.", copyable: false },
        { prompt: "…", run: "15 minutos sin llamadas", note: "Chrome se cierra. La siguiente llamada lo abre otra vez, con el mismo perfil y las mismas cookies.", copyable: false },
        { prompt: "$", run: CMD.set, note: "Cada límite es un ajuste de la identidad." },
      ],
      aside: "Por defecto: 8 páginas, en pausa a los 5 minutos, cerradas a los 15.",
      more: { text: "Pestañas y ciclo de vida", href: `${DOCS}#tabs` },
      rest: "ocho páginas abiertas",
    },
    vault: {
      tab: "bóveda",
      label: "las contraseñas no pasan por el modelo",
      headline: ["El modelo ", "nunca ve", " tus contraseñas."],
      lead: "Una identidad puede guardar un usuario, una contraseña y el secreto de un código de un solo uso por sitio en el llavero de tu sistema. El agente pide iniciar sesión por el nombre del sitio. La herramienta llena el formulario, solo en las direcciones de ese sitio, y oculta los valores en todos los resultados posteriores.",
      commands: [
        { prompt: "$", run: CMD.vaultAdd, note: "La contraseña y el secreto del código se piden sin mostrarse en pantalla." },
        { prompt: "tool", run: TOOL.login, note: "El agente nombra el sitio. La herramienta llena el usuario, la contraseña y el código vigente.", copyable: false },
      ],
      aside: "No envía el formulario a menos que lo actives para la identidad.",
      more: { text: "Bóveda de credenciales", href: `${DOCS}#credential-vault` },
      rest: "todavía no hay nada guardado",
    },
  },
  pictures: {
    list: "Pasos: elige uno para correrlo en la imagen",
    identities: {
      figure: "El perfil de Chrome de la identidad school, primero vacío, luego con la sesión iniciada a mano y después abierto por un agente. Elige un paso para correrlo aquí.",
      you: "tú",
      agent: "agente",
      onDisk: "perfil en disco",
      none: "todavía no hay identidades",
      notYet: "sin sesión todavía",
      byHand: "inicias sesión a mano",
      signedIn: "sesión iniciada",
      kept: "cookies guardadas",
      saved: "ventana cerrada, la sesión quedó guardada en el perfil",
      arrived: "la página abre con la sesión iniciada: las cookies ya estaban en el perfil",
      page: "Mis cursos",
    },
    tabs: {
      figure: "Las páginas abiertas en el Chrome de una identidad y lo que pasa con ellas con el tiempo. Elige un paso para correrlo aquí.",
      cap: "máximo",
      current: "la pestaña del agente",
      running: "activas",
      parked: "en pausa",
      later5: "5 min después",
      later15: "15 min después",
      chromeClosed: "Chrome cerrado",
      onDisk: "perfil y cookies en disco",
      again: "la siguiente llamada abre Chrome otra vez con el mismo perfil, con la sesión iniciada",
      written: "guardado en los ajustes de la identidad: máximo 12 páginas, en pausa a los 10 minutos",
      idle: "15 minutos sin llamadas de herramientas: Chrome se cierra",
    },
    vault: {
      figure: "Una página de inicio de sesión, el llavero del sistema que guarda sus credenciales y lo que ve el modelo. Elige un paso para correrlo aquí.",
      keychain: "llavero del sistema",
      page: "la página",
      model: "lo que ve el modelo",
      nothing: "nada todavía",
      hidden: "oculto",
      username: "usuario",
      password: "contraseña",
      code: "código de un solo uso",
      stored: "guardado en el llavero del sistema, nunca en un archivo",
      signIn: "Iniciar sesión",
      notPart: "El modelo no participa en este paso.",
    },
  },
  more: {
    label: "también incluye",
    headline: ["Lo demás que ", "trae", "."],
    cards: [
      {
        title: "Lleva una sesión iniciada a otra máquina",
        text: "Cookies, localStorage e IndexedDB en un archivo cifrado con una frase que tú escribes. Caduca, y nunca lleva las credenciales de la bóveda.",
        run: CMD.export,
        more: { text: "Mover una sesión", href: `${DOCS}#moving-a-session` },
      },
      {
        title: "Varios agentes, un navegador",
        text: "Varias sesiones de agentes usan a la vez el Chrome de una identidad, cada una en sus propias pestañas. Viene apagado hasta que lo actives.",
        run: CMD.sharing,
        more: { text: "Compartir un navegador", href: `${DOCS}#several-agents-one-browser` },
      },
      {
        title: "Graba una vez, repite después",
        text: "Un agente guarda lo que hizo en un sitio como un flujo y lo corre de nuevo sin tener que entender la página otra vez.",
        run: CMD.replay,
        more: { text: "Flujos", href: `${DOCS}#flows-record-and-replay` },
      },
      {
        title: "Mira, y toma el control",
        text: "Ve lo que hace el agente en el navegador, ponlo en pausa y toma el control cuando una página te necesite.",
        run: CMD.live,
        more: { text: "Vista en vivo", href: `${DOCS}#live-view-and-take-over` },
      },
    ],
  },
  layers: {
    label: "dónde se ubica",
    headline: ["La capa ", "encima del driver", "."],
    lead: "Un driver mueve el navegador. turno-browser decide qué navegador es, de quién es la sesión que lleva, cuánto tiempo sigue abierto y qué alcanza a ver el modelo. Trabaja junto a browser-use, Stagehand y Browserbase, con Playwright debajo.",
    figure: "Cuatro capas, de arriba abajo: tus agentes, turno-browser, el driver y tu Chrome.",
    rows: [
      { name: "tus agentes", items: ["Claude Code", "Codex", "Copilot CLI", "Cursor CLI"] },
      { name: "turno-browser", items: ["identidades", "bóveda", "pestañas y ciclo de vida", "sesiones portables", "pestañas compartidas", "grabar y repetir", "vista en vivo"] },
      { name: "el driver", items: ["Playwright"] },
      { name: "el navegador", items: ["tu Google Chrome"] },
    ],
    beside: "Cada agente llega a él por MCP.",
    more: { text: "Cómo se compara", href: "/docs/browser-alternatives" },
  },
  setup: {
    label: "dos formas de empezar",
    headline: ["Solo, o ", "con turno", "."],
    alone: {
      title: "Solo",
      text: "turno-browser es su propio paquete. Instálalo, agrega una identidad y conecta tu agente.",
      commands: [
        { run: CMD.install, note: "El paquete y su comando." },
        { run: CMD.add, note: "Tu primera identidad." },
        { run: CMD.setup, note: "Imprime la entrada de MCP para tu agente." },
      ],
    },
    withTurno: {
      title: "Con turno",
      text: "El gateway de turno corre un solo servidor de navegador para todas las sesiones de todos los agentes, y lo detiene cuando nadie lo usa.",
      commands: [
        { run: CMD.withTurnoInstall, note: "Los dos paquetes." },
        { run: CMD.withTurnoAdd, note: "La identidad y su entrada en el gateway." },
      ],
      more: { text: "Qué hace turno", href: "/" },
    },
  },
  use: {
    label: "uso aceptable",
    text: "Úsalo con tus propias cuentas, en sitios cuyos términos te permitan el acceso automatizado, y a ritmo humano. No lo uses para sortear controles de acceso, muros de pago o límites, para extraer datos a gran escala, ni para entrar a cuentas que no son tuyas.",
    more: { text: "Leer la nota completa", href: `${DOCS}#acceptable-use` },
  },
  start: {
    label: "empezar",
    headline: ["Listo ", "con un comando", "."],
    text: "Instálalo, agrega una identidad e inicia sesión una vez. La documentación sigue desde ahí.",
    docs: "Leer la documentación",
    home: "Ver turno",
  },
};

const COPY: Record<Lang, BrowserCopy> = { en, es };

export function browserCopy(lang: Lang): BrowserCopy {
  return COPY[lang];
}
