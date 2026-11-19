import { type Server, createServer } from "node:http";
import type { Duplex } from "node:stream";
import { upstream } from "./upstream.js";

/**
 * A DevTools protocol relay between Patchright and a browser whose CDP is not Chrome's: one
 * Unix socket in, one out, messages passed through unchanged except the replies listed in
 * `fixReply`. turno uses it for Lightpanda, which answers a few methods in ways
 * Patchright does not expect; one of them (`DOM.getDocument` on its startup target, an empty
 * result) throws inside a Patchright event handler and ends the whole process.
 *
 * Both ends are Unix sockets in a folder only this user can open, so no TCP port is ever
 * listening for the browser.
 */

interface WsSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  terminate(): void;
  on(event: "message", listener: (data: Buffer | string) => void): unknown;
  on(event: "open" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

interface WsServer {
  handleUpgrade(request: unknown, socket: Duplex, head: Buffer, done: (client: WsSocket) => void): void;
  close(): void;
}

interface WsModule {
  ws: new (url: string, options?: Record<string, unknown>) => WsSocket;
  wsServer: new (options: Record<string, unknown>) => WsServer;
}

const OPEN = 1;

interface Message {
  id?: number;
  sessionId?: string;
  method?: string;
  result?: Record<string, unknown>;
  error?: unknown;
}

/**
 * The reply to send instead of `reply`, or undefined to pass it through. A reply Patchright would
 * choke on becomes a protocol error, which it handles (`_sendMayFail` returns nothing).
 */
export function fixReply(method: string | undefined, reply: Message): Message | undefined {
  if (method === "DOM.getDocument" && reply.result && !reply.result.root) {
    return {
      id: reply.id,
      ...(reply.sessionId ? { sessionId: reply.sessionId } : {}),
      error: { code: -32000, message: "No document on this target" },
    };
  }
  return undefined;
}

export interface CdpRelay {
  /** What Patchright connects to: `ws+unix://<socket>:/`. */
  endpoint: string;
  close(): Promise<void>;
}

/** Relays `listenPath` to the CDP server on `targetPath` (both Unix sockets). */
export async function startCdpRelay(listenPath: string, targetPath: string): Promise<CdpRelay> {
  const { ws: WebSocket, wsServer: WebSocketServer } = upstream().utils as unknown as WsModule;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
  const live = new Set<WsSocket>();
  const server: Server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  server.on("upgrade", (request, socket: Duplex, head: Buffer) => {
    wss.handleUpgrade(request, socket, head, (client) => {
      const target = new WebSocket(`ws+unix://${targetPath}:/`, { maxPayload: 256 * 1024 * 1024 });
      live.add(client);
      live.add(target);
      const queue: string[] = [];
      // The method of each request in flight, by session and id, to know what a reply answers.
      const methods = new Map<string, string>();
      target.on("open", () => {
        for (const m of queue.splice(0)) target.send(m);
      });
      client.on("message", (data) => {
        const text = data.toString();
        try {
          const m = JSON.parse(text) as Message;
          if (m.id !== undefined && m.method) methods.set(`${m.sessionId ?? ""}:${m.id}`, m.method);
        } catch {
          /* not JSON: pass it on and let the browser answer */
        }
        if (target.readyState === OPEN) target.send(text);
        else queue.push(text);
      });
      target.on("message", (data) => {
        let text = data.toString();
        try {
          const m = JSON.parse(text) as Message;
          if (m.id !== undefined) {
            const key = `${m.sessionId ?? ""}:${m.id}`;
            const fixed = fixReply(methods.get(key), m);
            methods.delete(key);
            if (fixed) text = JSON.stringify(fixed);
          }
        } catch {
          /* pass it through */
        }
        if (client.readyState === OPEN) client.send(text);
      });
      const end = () => {
        live.delete(client);
        live.delete(target);
        client.close();
        target.close();
      };
      client.on("close", end);
      target.on("close", end);
      client.on("error", end);
      target.on("error", end);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    endpoint: `ws+unix://${listenPath}:/`,
    async close() {
      for (const socket of live) socket.terminate();
      live.clear();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
