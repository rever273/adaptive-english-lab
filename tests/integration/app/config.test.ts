import { symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, resolveDataRoot } from "../../../apps/server/src/config.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

describe("data root confinement (spec/02, spec/11)", () => {
  it("defaults to <project>/var and loopback host; a database folder moves only the database, and only for the regular profile (D62)", () => {
    const dbDir = path.join(projectRoot, "var", "x-db-dir");
    const moved = loadConfig({} as NodeJS.ProcessEnv, projectRoot, { dbDir });
    expect(moved.dbPath.toLowerCase()).toBe(path.join(dbDir, "english-lab.sqlite").toLowerCase());
    expect(moved.backupsDir.toLowerCase()).toBe(path.join(projectRoot, "var", "backups").toLowerCase());
    expect(loadConfig({ ENGLISHLAB_DB_DIR: dbDir } as NodeJS.ProcessEnv, projectRoot, {}).dbPath.toLowerCase()).toBe(path.join(dbDir, "english-lab.sqlite").toLowerCase());
    const scratchProfile = loadConfig({ ENGLISHLAB_DATA_ROOT: path.join(projectRoot, "var", "x-scratch") } as NodeJS.ProcessEnv, projectRoot, { dbDir });
    expect(scratchProfile.dbPath.toLowerCase()).toBe(path.join(projectRoot, "var", "x-scratch", "db", "english-lab.sqlite").toLowerCase());
    expect(() => loadConfig({ ENGLISHLAB_DB_DIR: "\\\\server\\share" } as NodeJS.ProcessEnv, projectRoot, {})).toThrow(/database folder/);
    const c = loadConfig({} as NodeJS.ProcessEnv, projectRoot, {});
    expect(c.dataRoot.toLowerCase()).toBe(path.join(projectRoot, "var").toLowerCase());
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(4318);
    expect(c.dbPath).toContain(path.join("var", "db", "english-lab.sqlite"));
  });

  it.each([
    ["UNC", "\\\\server\\share\\x"],
    ["device", "\\\\.\\C:\\x"],
    ["extended-length", "\\\\?\\C:\\x"],
    ["relative", "var\\x"],
    ["traversal", path.join(projectRoot, "var", "..", "..", "x")],
    ["outside project", "C:\\Windows\\Temp\\english-lab"],
  ])("rejects %s path", (_name, p) => {
    expect(() => resolveDataRoot(p, projectRoot, "C:\\Users\\nobody\\AppData\\Local")).toThrow(ConfigError);
  });

  it("accepts a directory under %LOCALAPPDATA%\\EnglishLab", () => {
    const scratch = makeScratchRoot();
    try {
      const fakeLocal = path.join(scratch.root, "local");
      const r = resolveDataRoot(path.join(fakeLocal, "EnglishLab", "data"), projectRoot, fakeLocal);
      expect(r.toLowerCase()).toContain(path.join("local", "englishlab", "data").toLowerCase());
    } finally {
      scratch.cleanup();
    }
  });

  it("rejects a junction inside the project that escapes to outside it", () => {
    const scratch = makeScratchRoot();
    try {
      const link = path.join(scratch.root, "escape");
      try {
        symlinkSync("C:\\Windows\\Temp", link, "junction");
      } catch {
        return; // cannot create a junction here: nothing to assert
      }
      expect(() => resolveDataRoot(path.join(link, "x"), projectRoot, undefined)).toThrow(ConfigError);
    } finally {
      scratch.cleanup();
    }
  });

  it("validates port and dev origin", () => {
    expect(() => loadConfig({ ENGLISHLAB_PORT: "80" } as NodeJS.ProcessEnv, projectRoot)).toThrow(ConfigError);
    expect(() => loadConfig({ ENGLISHLAB_DEV_ORIGIN: "http://evil.example:5173" } as NodeJS.ProcessEnv, projectRoot)).toThrow(ConfigError);
    expect(loadConfig({ ENGLISHLAB_DEV_ORIGIN: "http://localhost:5173" } as NodeJS.ProcessEnv, projectRoot).devOrigin).toBe("http://localhost:5173");
  });
});
