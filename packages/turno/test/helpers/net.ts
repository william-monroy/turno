import { createServer } from "node:net";

/** A port nothing listens on: the system picks a free one, then it is released. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Runs `use` with a free port, and again with another one when something else took that port
 * between `freePort` and the listen in `use` (EADDRINUSE). Any other failure is the test's.
 */
export async function withFreePort<T>(use: (port: number) => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    try {
      return await use(port);
    } catch (err) {
      if (attempt >= attempts || !/EADDRINUSE/.test(String((err as Error)?.message ?? err))) throw err;
    }
  }
}
