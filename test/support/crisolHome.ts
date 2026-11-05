import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface TempHome {
  path: string;
  cleanup(): void;
}

/** Each test gets its OWN `CRISOL_HOME` (spec, Testing Decisions) — never the real `~/.crisol`. */
export function createTempHome(): TempHome {
  const home = mkdtempSync(path.join(tmpdir(), "crisol-home-"));
  return {
    path: home,
    cleanup(): void {
      rmSync(home, { recursive: true, force: true });
    },
  };
}
