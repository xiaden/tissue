// Internal liveness/readiness listener for the Tissue container.
// Readiness is informational only; it never controls process supervision.
import { createServer, type Server } from "node:http";
import { stat } from "node:fs/promises";
import type { TissueDb } from "../db/open.ts";

/**
 * Configuration for Tissue's internal HTTP health listener.
 *
 * Liveness is derived from the Tissue DB/process seam only. Registry and
 * resident reachability contribute to informational readiness and never
 * supervise or restart either service. The listener intentionally binds
 * 0.0.0.0 for Docker-network reachability; Compose exposes it without host
 * port publication. This interface carries no credentials and does not cover
 * resident lifecycle, webhooks, or GitHub App behavior.
 */
export interface HealthServerOptions {
  port: number;
  db?: TissueDb | { isOpen?: () => boolean };
  registryDir?: string;
  residentReachable?: () => Promise<boolean>;
}

/**
 * Running internal health listener handle.
 *
 * `close` releases the listener cleanly for shutdown and tests. The listener
 * is not a restart supervisor and does not manage the resident OpenCode
 * process.
 */
export interface HealthServer {
  url: string;
  close(): Promise<void>;
}

type HealthBody = {
  liveness: boolean;
  readiness: boolean;
  residentReachable: boolean;
};

async function registryIsAvailable(registryDir: string | undefined): Promise<boolean> {
  if (registryDir === undefined) return false;
  try {
    const info = await stat(registryDir);
    return info.isDirectory();
  } catch {
    return false;
  }
}

function dbIsOpen(db: HealthServerOptions["db"]): boolean {
  if (db === undefined) return true;
  const probe = db as { isOpen?: () => boolean; raw?: TissueDb["raw"] };
  if (typeof probe.isOpen === "function") {
    try {
      return probe.isOpen();
    } catch {
      return false;
    }
  }
  // TissueDb's native handle is authoritative when no test seam is supplied.
  try {
    probe.raw?.exec("SELECT 1");
    return probe.raw !== undefined;
  } catch {
    return false;
  }
}

export async function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const residentProbeTimeoutMs = 250;
  let registryReady = false;
  let residentReachable = false;
  let refreshInFlight: Promise<void> | undefined;

  const refreshReadiness = (): void => {
    if (refreshInFlight !== undefined) return;
    const residentProbe = options.residentReachable ?? (async () => true);
    const boundedResidentProbe = Promise.race([
      residentProbe().then((value) => value === true, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), residentProbeTimeoutMs)),
    ]);
    refreshInFlight = Promise.all([registryIsAvailable(options.registryDir), boundedResidentProbe])
      .then(([nextRegistryReady, nextResidentReachable]): void => {
        registryReady = nextRegistryReady;
        residentReachable = nextResidentReachable;
      })
      .catch((): void => {
        registryReady = false;
        residentReachable = false;
      })
      .finally((): void => {
        refreshInFlight = undefined;
      });
    void refreshInFlight;
  };

  const server: Server = createServer((request, response) => {
    if (request.method !== "GET" || (request.url ?? "/") !== "/") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const liveness = dbIsOpen(options.db);
    const body: HealthBody = {
      liveness,
      readiness: registryReady && residentReachable,
      residentReachable,
    };
    response.writeHead(liveness ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
    refreshReadiness();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") {
        reject(new Error(`health server port ${options.port} is already in use (EADDRINUSE)`));
      } else {
        reject(error);
      }
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, "0.0.0.0");
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("health server did not expose a network address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }),
  };
}
