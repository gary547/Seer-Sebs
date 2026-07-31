import type { Server } from "node:http";
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
  servers: readonly Server[],
  closeResources: () => Promise<void>,
): void {
  let shuttingDown = false;

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
