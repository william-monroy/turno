import { join } from "node:path";
import { paths } from "../core/paths.js";
import { type ServiceBackend, type ServiceSpec, runTool, serviceArgs, serviceEnv } from "./service.js";

export const UNIT = "turno-mcpd.service";

export function unitPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(paths(env).home, ".config");
  return join(base, "systemd", "user", UNIT);
}

/** One word of ExecStart or Environment, quoted for systemd: specifiers and variables are escaped. */
function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

function unquote(s: string): string {
  return s
    .replace(/\$\$/g, "$")
    .replace(/%%/g, "%")
    .replace(/\\(["\\])/g, "$1");
}

/**
 * `systemd --user` unit that keeps `turno mcp daemon run` alive. Restart=on-failure: a clean
 * exit (another mcpd already serves) is not restarted, a crash is.
 */
export function unit(spec: ServiceSpec): string {
  const env = Object.entries(serviceEnv(spec, "systemd"))
    .map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=turno MCP gateway (mcpd)
Documentation=https://github.com/wimo-dev/turno

[Service]
Type=simple
ExecStart=${serviceArgs(spec).map(quote).join(" ")}
${env}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** The ExecStart words of a unit written by `unit()`. */
export function unitProgram(text: string): string[] {
  const line = /^ExecStart=(.*)$/m.exec(text)?.[1];
  if (!line) return [];
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? unquote(m[1]) : m[2]!));
}

const ctl = (env: NodeJS.ProcessEnv, ...args: string[]) => runTool("systemctl", ["--user", ...args], env);

export const systemd: ServiceBackend = {
  kind: "systemd",
  noun: "systemd user unit",
  file: unitPath,
  render: unit,
  programOf: unitProgram,
  async isLoaded(env) {
    try {
      await ctl(env, "is-enabled", "--quiet", UNIT);
      return true;
    } catch {
      try {
        await ctl(env, "is-active", "--quiet", UNIT);
        return true;
      } catch {
        return false;
      }
    }
  },
  async load(env) {
    await ctl(env, "daemon-reload");
    await ctl(env, "enable", UNIT);
    await ctl(env, "restart", UNIT);
  },
  async unload(env) {
    await ctl(env, "disable", "--now", UNIT);
  },
  async restart(env) {
    await ctl(env, "restart", UNIT);
  },
};
