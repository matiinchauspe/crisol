import { dlopen, FFIType, read } from "bun:ffi";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { slotPath, slotsDir } from "./paths";

/** A lock taken on one Slot's file; the OS drops it when its process dies, however it dies. */
export interface HeldLock {
  /** Idempotent. */
  release(): void;
}

/** The only OS-dependent half of Slots — `acquireSlot` never touches a lock primitive directly. */
export interface SlotLock {
  /** Never blocks: `undefined` means another holder has it. */
  tryLock(path: string): HeldLock | undefined;
}

// Darwin's <sys/fcntl.h> and <sys/errno.h>, checked against the SDK headers.
const LOCK_EX = 0x02;
const LOCK_NB = 0x04;
const EINTR = 4;
const EWOULDBLOCK = 35;

type Libc = {
  flock(fd: number, operation: number): number;
  errno(): number;
};

let libc: Libc | undefined;

// Opened on first use, never at import: on another OS the platform message must win, and
// libSystem only exists on macOS.
function loadLibc(): Libc {
  if (libc) return libc;
  const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
  });
  libc = {
    flock: (fd, operation) => symbols.flock(fd, operation),
    errno: () => read.i32(symbols.__error()!, 0),
  };
  return libc;
}

/**
 * v1's `SlotLock`: an exclusive `flock` on a file opened by this process. `flock` locks the
 * open file description, so two Runs in one process still exclude each other, and the fd is
 * close-on-exec (Bun's `openSync` sets it), so a spawned `docker exec` that outlives a
 * SIGKILLed Crisol never keeps the Slot alive.
 */
export class DarwinFlockSlotLock implements SlotLock {
  tryLock(path: string): HeldLock | undefined {
    const { flock, errno } = loadLibc();
    const fd = openSync(path, "a");
    let code: number;
    do {
      if (flock(fd, LOCK_EX | LOCK_NB) === 0) {
        let held = true;
        return {
          release(): void {
            if (!held) return;
            held = false;
            closeSync(fd);
          },
        };
      }
      code = errno();
    } while (code === EINTR);
    closeSync(fd);
    if (code === EWOULDBLOCK) return undefined;
    throw new Error(`flock on ${path} failed with errno ${code}.`);
  }
}

/**
 * A Run lock is the Slot's primitive on the Run's own dir. The Slot cannot prove a Run alive:
 * once a Run dies, a later Run may take the same Slot.
 */
export function tryLockRun(path: string, lock: SlotLock = new DarwinFlockSlotLock()): HeldLock | undefined {
  return lock.tryLock(path);
}

export interface Slot {
  /** 1-based: `<index>.lock` under `~/.crisol/slots/`. */
  readonly index: number;
  release(): void;
}

export interface AcquireSlotOptions {
  home: string;
  maxParallel: number;
  lock?: SlotLock;
  pollMs?: number;
  /** Called once, the first time every Slot is found taken. */
  onWait?: () => void;
  /** Aborting gives up the wait; it never interrupts a Slot already held. */
  signal?: AbortSignal;
}

/**
 * Waits as long as it takes — a Run never fails for lack of a Slot. Polling rather than a
 * blocking `flock`, which would stall the whole event loop: a fan-out's other Runs and
 * every signal handler live on that same thread.
 */
export async function acquireSlot(options: AcquireSlotOptions): Promise<Slot> {
  const { home, maxParallel, lock = new DarwinFlockSlotLock(), pollMs = 250, onWait, signal } = options;
  mkdirSync(slotsDir(home), { recursive: true });
  let notified = false;
  while (true) {
    if (signal?.aborted) {
      throw new Error("Interrupted while waiting for a Slot.");
    }
    for (let index = 1; index <= maxParallel; index++) {
      const held = lock.tryLock(slotPath(index, home));
      if (held) return { index, release: () => held.release() };
    }
    if (!notified) {
      notified = true;
      onWait?.();
    }
    await Bun.sleep(pollMs);
  }
}
