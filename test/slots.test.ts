import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { slotPath } from "../src/paths";
import { acquireSlot } from "../src/slots";
import { createTempHome } from "./support/crisolHome";

const HOLD_SLOT = path.join(import.meta.dir, "support", "holdSlot.ts");

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await Bun.sleep(ms);
  return settled;
}

describe("acquireSlot", () => {
  test("takes ~/.crisol/slots/<n>.lock, numbered from 1", async () => {
    const home = createTempHome();
    try {
      const slot = await acquireSlot({ home: home.path, maxParallel: 3 });
      try {
        expect(slot.index).toBe(1);
        expect(existsSync(slotPath(1, home.path))).toBe(true);
      } finally {
        slot.release();
      }
    } finally {
      home.cleanup();
    }
  });

  test("hands out max_parallel distinct Slots, then makes the next one wait until one is released", async () => {
    const home = createTempHome();
    try {
      const held = await Promise.all([1, 2, 3].map(() => acquireSlot({ home: home.path, maxParallel: 3, pollMs: 20 })));
      expect(held.map((slot) => slot.index).sort()).toEqual([1, 2, 3]);

      let waited = false;
      const fourth = acquireSlot({
        home: home.path,
        maxParallel: 3,
        pollMs: 20,
        onWait: () => (waited = true),
      });
      expect(await settlesWithin(fourth, 300)).toBe(false);
      expect(waited).toBe(true);

      held[1]!.release();
      const slot = await fourth;
      expect(slot.index).toBe(held[1]!.index);

      slot.release();
      held[0]!.release();
      held[2]!.release();
    } finally {
      home.cleanup();
    }
  });

  test("release is idempotent and frees the Slot for the next taker", async () => {
    const home = createTempHome();
    try {
      const first = await acquireSlot({ home: home.path, maxParallel: 1 });
      first.release();
      first.release();
      const second = await acquireSlot({ home: home.path, maxParallel: 1, pollMs: 20 });
      second.release();
    } finally {
      home.cleanup();
    }
  });

  test("an abort while waiting rejects and leaves no Slot held", async () => {
    const home = createTempHome();
    try {
      const holder = await acquireSlot({ home: home.path, maxParallel: 1 });
      const controller = new AbortController();
      const waiting = acquireSlot({ home: home.path, maxParallel: 1, pollMs: 20, signal: controller.signal });
      await Bun.sleep(60);
      controller.abort();
      await expect(waiting).rejects.toThrow(/waiting for a Slot/i);

      holder.release();
      const next = await acquireSlot({ home: home.path, maxParallel: 1, pollMs: 20 });
      next.release();
    } finally {
      home.cleanup();
    }
  });

  test("the OS releases a Slot whose holder was killed with SIGKILL — no ghost Slots", async () => {
    const home = createTempHome();
    try {
      // The holder also spawns a long-lived child that outlives it: the lock must still be
      // released, which only holds if the lock's fd never leaks into a spawned process.
      const holder = Bun.spawn(["bun", "run", HOLD_SLOT, home.path], { stdout: "pipe", stderr: "pipe" });
      const reader = holder.stdout.getReader();
      const { value } = await reader.read();
      const [heldLine, childLine] = new TextDecoder().decode(value).trim().split("\n");
      expect(heldLine).toBe("held 1");
      const childPid = Number(childLine?.replace("child ", ""));

      try {
        const waiting = acquireSlot({ home: home.path, maxParallel: 1, pollMs: 20 });
        expect(await settlesWithin(waiting, 300)).toBe(false);

        holder.kill("SIGKILL");
        await holder.exited;

        const slot = await waiting;
        expect(slot.index).toBe(1);
        expect(() => process.kill(childPid, 0)).not.toThrow();
        slot.release();
      } finally {
        if (childPid > 0) process.kill(childPid, "SIGKILL");
      }
    } finally {
      home.cleanup();
    }
  }, 15_000);
});
