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
cuenta: los repositorios del trabajo abren con tu cuenta del trabajo y lo demás con la personal.

![turno: perfiles de dos agentes, un gateway y la status line](docs/assets/demo.gif)

## Instalación

```sh
npx turno-cli@latest doctor     # pruébalo sin instalar: revisa tus agentes y tu configuración
npm install --global turno-cli  # macOS o Linux, Node 22.11 o más nuevo
```

El paquete de npm se llama `turno-cli`; el comando que instala es `turno`.

Después pasa tus servidores MCP detrás del gateway:

```sh
turno mcp import --move-secrets --write   # mcp.toml a partir de los servidores que ya tienes
turno mcp daemon start                    # el gateway, mantenido por launchd
turno mcp sync                            # apunta cada perfil de cada agente al gateway
```

Nada sale de tu máquina: no hay cuenta, ni telemetría, ni proxy del tráfico con el modelo.

## Inicio rápido

```sh
turno profile add trabajo --color violet  # ~/.claude-trabajo y el comando claude-trabajo
turno profile add personal
claude-trabajo                            # inicia sesión una vez por perfil (/login)
turno profile assign ~/code/acme trabajo  # esta carpeta y todo lo que tiene adentro
turno config set default personal         # carpetas sin regla
cd ~/code/acme && turno auto              # Claude Code con la cuenta del trabajo
```

Los perfiles de Codex, Copilot y Cursor son iguales, con `--agent codex|copilot|cursor`. Los
detalles de cada agente están en [docs/agents.md](docs/agents.md) y la referencia completa de
comandos y configuración, en el [README en inglés](README.md#reference).

## Preguntas frecuentes

**¿Está permitido usar varias cuentas?** Depende de tu plan, no de turno. turno ejecuta la CLI
oficial de cada proveedor sin modificarla, y cada cuenta inicia sesión con el login del propio
proveedor en su propia carpeta. El uso pensado es separar cuentas de trabajo y personales. No lo
uses para sortear límites de uso ni salvaguardas; lee [Vendor terms](README.md#vendor-terms).

**¿Dónde quedan mis credenciales?** Donde cada agente las guarda, dentro de la carpeta del perfil
(o en el Llavero, si el agente lo usa). turno nunca lee, copia ni reenvía tokens de sesión.

**¿turno ve mis prompts?** No. Lanza el agente y se hace a un lado. Solo las llamadas a
herramientas MCP pasan por `mcpd`, en `127.0.0.1` y con un token.

**¿Cómo lo deshago?** Cada comando que escribe guarda una copia de lo que cambia:
`turno undo --list` las muestra y `turno undo <stamp>` las restaura.

## Contribuir

Las preguntas en español son bienvenidas en
[Discussions](https://github.com/william-monroy/turno/discussions), en la categoría Español.
Lee [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir un pull request. Hecho en Monterrey,
México. Licencia Apache 2.0.
