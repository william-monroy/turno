<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo-light.svg" alt="turno" width="168" height="56">
  </picture>
</p>

<p align="center">
  <b>Un gateway MCP y una cuenta por carpeta para Claude Code, Codex, Copilot CLI y Cursor CLI.</b>
</p>

<p align="center">
  <a href="README.md">English</a> · Español
</p>

Cada sesión de un agente de código arranca su propia copia de cada servidor MCP. Ocho sesiones
con seis servidores comunes ocupan **3,163 MiB en 56 procesos**. turno arranca cada servidor una
sola vez, solo cuando se llama una de sus herramientas, detrás de un gateway local que comparten
todas las sesiones de todos los agentes: **847 MiB con los seis servidores corriendo y 103 MiB
mientras están inactivos** ([benchmark](BENCHMARKS.md)). Además, cada carpeta usa su propia
cuenta y su propio conjunto de servidores MCP: los repositorios del trabajo abren con tu cuenta
del trabajo y lo demás con la personal.

![turno demo: dos perfiles, un gateway, la status line, el selector y turno doctor, en un HOME desechable](docs/assets/demo.gif)

## Instalación

```sh
npx turno-cli demo              # pruébalo primero, en un HOME desechable; no toca tu configuración
npm install --global turno-cli  # macOS o Linux, Node 22.11 o más nuevo
brew tap wimo-dev/turno && brew trust wimo-dev/turno && brew install turno  # o con Homebrew
```

El paquete de npm se llama `turno-cli`; el comando que instala es `turno`. No ejecuta scripts de
instalación e incluye un `npm-shrinkwrap.json`, así que instalas exactamente las versiones de
dependencias que se probaron (CI revisa ambas cosas). Nada sale de tu máquina: no hay cuenta,
ni telemetría, ni proxy del tráfico con el modelo.

## Inicio rápido

```sh
turno init                    # encuentra tus agentes, perfiles, carpetas y servidores MCP, muestra el diff,
                              # arranca el gateway y apunta cada perfil a él
claude-trabajo                # inicia sesión una vez por perfil (/login)
cd ~/code/acme && turno auto  # Claude Code, con la cuenta de esta carpeta
turno                         # dónde estás: esta carpeta, cuentas, gateway y qué sigue
```

`turno init` pregunta antes de adoptar cualquier cosa y escribe todo como un solo cambio, así
que un solo `turno undo <stamp>` lo revierte. El gateway corre como servicio de sesión (launchd
en macOS, systemd --user en Linux); `turno init --no-start` lo deja para después
(`turno mcp daemon start` y luego `turno mcp sync`). Paso a paso:

```sh
turno profile add trabajo --color violet  # ~/.claude-trabajo y el comando claude-trabajo
turno profile add personal
claude-trabajo                            # inicia sesión una vez por perfil (/login)
turno profile assign ~/code/acme trabajo  # esta carpeta y todo lo que tiene adentro
turno config set default personal         # carpetas sin regla
turno mcp import --move-secrets --write   # mcp.toml a partir de los servidores que ya tienes
turno mcp daemon start && turno mcp sync  # el gateway, y cada perfil apuntando a él
cd ~/code/acme && turno auto              # Claude Code con la cuenta del trabajo
```

Los perfiles de Codex, Copilot y Cursor son iguales, con `--agent codex|copilot|cursor`. Los
lanzadores van en `~/.local/bin`; si no está en tu `PATH`, `turno profile add` te da la línea
que hay que agregar y mientras tanto funciona `turno trabajo`. `turno auto` nunca cambia de
cuenta en silencio: si falta el perfil o `config.toml` tiene un error, se detiene y te dice el
comando que lo arregla.

Una regla de carpeta también puede elegir qué servidores MCP ven las sesiones de esa carpeta:

```toml
[[projects]]
path = "~/code/oss"
mcp_deny = ["mail"]     # aquí las sesiones ven todos los servidores MCP menos mail
```

Los detalles de cada agente están en [docs/agents.md](docs/agents.md), los del gateway en
[docs/mcp.md](docs/mcp.md), y la referencia completa de comandos y configuración, en el
[README en inglés](README.md#reference).

## Preguntas frecuentes

**¿Está permitido usar varias cuentas?** Depende de tu plan, no de turno. turno ejecuta la CLI
oficial de cada proveedor sin modificarla, y cada cuenta inicia sesión con el login del propio
proveedor en su propia carpeta. El uso pensado es separar cuentas de trabajo y personales. No lo
uses para sortear límites de uso ni salvaguardas; lee [Vendor terms](README.md#vendor-terms).

**¿Dónde quedan mis credenciales?** Donde cada agente las guarda, dentro de la carpeta del perfil
(o en el Llavero, si el agente lo usa). turno nunca lee, copia ni reenvía tokens de sesión. Los
secretos MCP que mueves con `--move-secrets` y los tokens OAuth de servidores MCP remotos van al
Llavero de macOS o al Secret Service de Linux. Qué guarda turno y dónde: [SECURITY.md](SECURITY.md).

**¿turno ve mis prompts?** No. Lanza el agente y se hace a un lado. Solo las llamadas a
herramientas MCP pasan por `mcpd`, en `127.0.0.1` y con un token por perfil.

**¿Pueden usar turno los scripts y los agentes?** Sí. turno solo pregunta cuando hay una
persona en una terminal: con `--no-input` (o `TURNO_NO_INPUT=1`), cuando stdin no es una
terminal y dentro de una sesión de agente de Claude Code, Codex, Copilot CLI o Cursor nunca
pregunta. Un comando que necesitaría preguntar termina con código 2 y nombra la opción que lo
responde, por ejemplo `turno: init needs an answer; pass --yes (or run it in a terminal)`.
`TURNO_NO_INPUT=0` te deja responder en la terminal de un editor que define la variable de un
agente. Un comando que necesita un perfil y no lo recibe (`turno profile assign`, `turno run`,
`turno session handoff`, `turno limit set`) muestra una lista para elegir en una terminal
(flechas o j/k, escribir para filtrar, Enter, Esc para cancelar); fuera de ella termina con
código 2 y lista los perfiles: `pass a profile: personal, work`.

**¿Cómo lo deshago?** Cada comando que escribe guarda una copia de lo que cambia:
`turno undo --list` las muestra y `turno undo <stamp>` las restaura (las copias de más de 30
días se borran, conservando las 10 más recientes). Para quitar turno, `turno uninstall
--dry-run` muestra lo que turno configuró (servicio, lanzadores, entradas MCP, status line,
configuración) y `turno uninstall` lo quita; después, `npm uninstall --global turno-cli`. Las
carpetas de los perfiles, que guardan tus credenciales y tu historial, se quedan hasta que tú
las borres.

## Contribuir

Las preguntas en español son bienvenidas en
[Discussions](https://github.com/wimo-dev/turno/discussions), en la categoría Español.
Lee [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir un pull request. Hecho en Monterrey,
México. Licencia Apache 2.0.
