import { type Server, createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";

/**
 * A forward HTTP proxy on 127.0.0.1 for the tests of identity.json `proxy` (never a real proxy
 * service): it wants Basic credentials, relays plain http:// requests and CONNECT tunnels, and
 * counts what it relayed. `listen` starts the server and returns its port (the caller closes it).
 */
export async function localProxy(user: string, password: string, listen: (server: Server) => Promise<number>) {
  const expected = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const seen = { relayed: [] as string[], refused: 0, wrongCredentials: 0 };
  const server = createServer((req, res) => {
    const auth = req.headers["proxy-authorization"];
    if (auth !== expected) {
      if (auth) seen.wrongCredentials++;
      seen.refused++;
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="test"' });
      res.end();
      return;
    }
    const target = new URL(req.url ?? "");
    seen.relayed.push(target.pathname);
    const { "proxy-authorization": _auth, "proxy-connection": _conn, ...rest } = req.headers;
    const out = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: req.method,
        headers: rest,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    out.on("error", () => res.destroy());
    res.on("error", () => {});
    req.pipe(out);
  });
  server.on("connect", (req, client) => {
    client.on("error", () => {});
    if (req.headers["proxy-authorization"] !== expected) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
      return;
    }
    const [host, port] = (req.url ?? "").split(":");
    const up = connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.pipe(client);
      client.pipe(up);
    });
    up.on("error", () => client.destroy());
  });
  const port = await listen(server);
  return { server: `http://127.0.0.1:${port}`, seen };
}
