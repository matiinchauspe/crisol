import { dlopen, FFIType, read } from "bun:ffi";
import { closeSync, fstatSync, mkdirSync, openSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { slotPath, slotsDir } from "./paths";

/** A lock taken on one Slot's file; the OS drops it when its process dies, however it dies. */
export interface HeldLock {
  /** The fd the lock is held on, so a detached Run can inherit it. */
  readonly fd: number;
  /** Idempotent. */
  release(): void;
}

/** The only OS-dependent half of Slots — `acquireSlot` never touches a lock primitive directly. */
export interface SlotLock {
  /**
   * Never blocks: `undefined` means another holder has it. With `create: false` a missing file
   * throws ENOENT instead of being made.
   */
  tryLock(path: string, options?: { create?: boolean }): HeldLock | undefined;
}

// Darwin's <sys/fcntl.h> and <sys/errno.h>, checked against the SDK headers; Linux's
// <sys/file.h> flock constants are the same, only EWOULDBLOCK differs (SPIKE: Linux values
// from <asm-generic/errno-base.h>, not yet run on Linux).
const LOCK_EX = 0x02;
const LOCK_NB = 0x04;
const EINTR = 4;
const IS_LINUX = process.platform === "linux";
const EWOULDBLOCK = IS_LINUX ? 11 : 35;

type Libc = {
  flock(fd: number, operation: number): number;
  errno(): number;
};

let libc: Libc | undefined;

// Opened on first use, never at import: on another OS the platform message must win, and
// libSystem only exists on macOS.
function loadLibc(): Libc {
  if (libc) return libc;
  const flockSymbol = { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } as const;
  if (IS_LINUX) {
    const { symbols } = dlopen("libc.so.6", {
      flock: flockSymbol,
      __errno_location: { args: [], returns: FFIType.ptr },
    });
    libc = {
      flock: (fd, operation) => symbols.flock(fd, operation),
      errno: () => read.i32(symbols.__errno_location()!, 0),
    };
    return libc;
  }
  const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
    flock: flockSymbol,
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
  tryLock(path: string, options: { create?: boolean } = {}): HeldLock | undefined {
    const { flock, errno } = loadLibc();
    const fd = openSync(path, options.create === false ? "r" : "a");
    let code: number;
    do {
      if (flock(fd, LOCK_EX | LOCK_NB) === 0) {
        return heldOn(fd);
      }
      code = errno();
    } while (code === EINTR);
    closeSync(fd);
    if (code === EWOULDBLOCK) return undefined;
    throw new Error(`flock on ${path} failed with errno ${code}.`);
  }
}

function heldOn(fd: number): HeldLock {
  let held = true;
  return {
    fd,
    release(): void {
      if (!held) return;
      held = false;
      closeSync(fd);
    },
  };
}

/**
 * Takes over a lock a parent process took and passed down as `fd`. `flock` belongs to the open
 * file description, so the inherited fd holds the parent's lock without ever letting go of it.
 * The inherited fd is not close-on-exec; Bun's spawn still hands a child only the fds it names,
 * so no `docker exec` that outlives this process keeps the lock. Refuses an fd not open on `path`.
 */
export function adoptLock(fd: number, path: string): HeldLock {
  let inherited: Stats;
  try {
    inherited = fstatSync(fd);
  } catch {
    throw new Error(`No inherited lock on fd ${fd} for ${path}.`);
  }
  const expected = statSync(path);
  if (inherited.ino !== expected.ino || inherited.dev !== expected.dev) {
    throw new Error(`fd ${fd} is not open on ${path}.`);
  }
  return heldOn(fd);
}

/**
 * A Run lock is the Slot's primitive on the Run's own dir. The Slot cannot prove a Run alive:
 * once a Run dies, a later Run may take the same Slot.
 */
export function tryLockRun(path: string, lock: SlotLock = new DarwinFlockSlotLock()): HeldLock | undefined {
  return lock.tryLock(path);
}

/**
 * Tries the lock of a Run that already has one, for `status` and `recover`. Never creates the
 * file: a dir removed under a probe would otherwise get back an empty lock with no record, which
 * every later probe skips. `"gone"` when the file no longer exists.
 */
export function probeRunLock(path: string, lock: SlotLock = new DarwinFlockSlotLock()): HeldLock | undefined | "gone" {
  try {
    return lock.tryLock(path, { create: false });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return "gone";
    throw error;
  }
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
