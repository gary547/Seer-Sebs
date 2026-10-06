import type { Server } from "node:http";
import type { Http2Server, ServerHttp2Session } from "node:http2";
import process from "node:process";

export function resolvePort(value: string | undefined, fallback = 8080): number {
  const port = Number(value ?? String(fallback));

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT value: ${value ?? ""}`);
  }

  return port;
}

export function installShutdownHandlers(
  serviceName: string,
  servers: readonly (Server | Http2Server)[],
  closeResources: () => Promise<void>,
): void {
  let shuttingDown = false;
  const sessions = new Set<ServerHttp2Session>();
  for (const server of servers) {
    if ("updateSettings" in server) {
      server.on("session", (session: ServerHttp2Session) => {
        sessions.add(session);
        session.once("close", () => sessions.delete(session));
      });
    }
  }

  async function shutDown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`${serviceName} received ${signal}`);

    for (const server of servers) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
        for (const session of sessions) session.close();
      });
    }

    await closeResources();
  }

  process.once("SIGINT", (signal) => {
    void shutDown(signal).catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", (signal) => {
    void shutDown(signal).catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
}
