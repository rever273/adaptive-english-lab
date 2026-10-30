import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type AppConfig } from "../../apps/server/src/config.js";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Scratch data roots live inside the project (var/ is git-ignored), as required for the data root. */
export function makeScratchRoot(): { root: string; cleanup: () => void } {
  const root = path.join(projectRoot, "var", "test-runs", randomUUID());
  mkdirSync(root, { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

export function testConfig(dataRoot: string, port: number): AppConfig {
  return loadConfig({ ENGLISHLAB_DATA_ROOT: dataRoot, ENGLISHLAB_PORT: String(port) } as NodeJS.ProcessEnv, projectRoot);
}
