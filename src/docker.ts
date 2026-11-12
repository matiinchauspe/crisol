export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** One extra bind mount an Adapter declares pre-start. */
export interface MountSpec {
  hostPath: string;
  containerPath: string;
  mode: "ro" | "rw";
}

export interface StopResult {
  ok: boolean;
  stderr: string;
}

export interface Sandbox {
  readonly containerId: string;
  /** Logged by `run.ts` as the one source of truth for what was actually mounted. */
  readonly mounts: readonly string[];
  exec(cmd: string[]): Promise<ExecResult>;
  /** Reports whether teardown actually succeeded — callers must never log "stopped" when `ok` is false. */
  stop(): Promise<StopResult>;
}

/** Deliberately minimal placeholder (git + bash on Alpine) — not the full Project + Agent image layering. */
export const SKELETON_DOCKERFILE = "FROM alpine:3.20\nRUN apk add --no-cache git bash\n";

export const SKELETON_IMAGE_TAG = "crisol-base:0.1.0-skeleton";

function run(args: string[]): ExecResult {
  // Explicit `env: process.env` — without it, `Bun.spawnSync` misses env mutations
  // made at runtime (e.g. a test pinning `DOCKER_HOST`).
  const proc = Bun.spawnSync(args, { env: process.env, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString("utf8"),
    stderr: proc.stderr.toString("utf8"),
  };
}

function imageExists(tag: string): boolean {
  return run(["docker", "image", "inspect", tag]).exitCode === 0;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

/**
 * Fails with a plain message, not a socket error, when the Docker engine is
 * unreachable. Also catches the `docker` CLI binary itself missing from PATH:
 * `Bun.spawnSync` THROWS synchronously with ENOENT in that case rather than a
 * non-zero exit code, which would otherwise leak a raw spawn error to the user.
 */
export function assertDockerReachable(): void {
  let result: ExecResult;
  try {
    result = run(["docker", "info", "--format", "{{.ServerVersion}}"]);
  } catch (error) {
    if (isEnoent(error)) {
      throw new Error(
        "The `docker` CLI was not found on PATH. Install Docker (OrbStack, Docker Desktop, " +
          "or another engine) and try again.",
      );
    }
    throw error;
  }
  if (result.exitCode !== 0) {
    throw new Error(
      "Docker engine is not reachable. Start it (for example `orb start` for OrbStack, " +
        "or open Docker Desktop) and try again.",
    );
  }
}

/** `docker image inspect` is the whole cache key for this placeholder image; a real content-hash cache is later work. */
export async function ensureBaseImage(tag: string = SKELETON_IMAGE_TAG): Promise<string> {
  if (imageExists(tag)) return tag;

  const proc = Bun.spawn(["docker", "build", "-q", "-t", tag, "-"], {
    stdin: new Blob([SKELETON_DOCKERFILE]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`docker build failed for ${tag}: ${stderr.trim()}`);
  }
  return tag;
}

export interface StartSandboxOptions {
  image: string;
  /** Bind-mounted at the same absolute path inside. */
  mountPath: string;
  /** Non-secret env, embedded directly in argv as `KEY=value` — never a secret. */
  env: Record<string, string>;
  /**
   * NAMES only, never values. Passed to `docker run` as a bare `-e NAME`; docker
   * reads the VALUE from the spawned process's own environment, so a secret never
   * lands on the docker argv (visible in `ps`, shell history, or this process's logs).
   */
  secretEnvNames?: readonly string[];
  /** A value for a name in `secretEnvNames` not already in this process's own env (a Keychain-sourced token) — merged into the spawned docker CLI's env only, never into `process.env` or the argv. */
  secretEnv?: Record<string, string>;
  /** Extra mounts an Adapter declares pre-start — empty for the fake Adapter. */
  mounts?: readonly MountSpec[];
  /** Becomes the container's `--name crisol-<id>` and `--label crisol.run=<id>`. */
  id: string;
}

/** Human-readable bookkeeping summary only — never what's passed to `docker run`; see `buildMountFlag` for that. */
function formatMount(hostPath: string, containerPath: string, mode: "ro" | "rw"): string {
  return mode === "ro" ? `${hostPath}:${containerPath}:ro` : `${hostPath}:${containerPath}`;
}

/**
 * Uses `--mount`, not the older `-v`/`--volume` shorthand: `--mount`'s explicit
 * `type=bind,source=,target=` keys are unambiguous, where `-v`'s colon-separated
 * shorthand is a source of parsing surprises around paths containing a colon.
 */
function buildMountFlag(hostPath: string, containerPath: string, mode: "ro" | "rw"): string[] {
  const spec = `type=bind,source=${hostPath},target=${containerPath}${mode === "ro" ? ",readonly" : ""}`;
  return ["--mount", spec];
}

/**
 * Pure function of its inputs, unit tested without Docker — proves secrets never
 * appear as a VALUE on the argv, only as a bare `-e NAME`. `startSandbox` is the
 * only caller that spawns it.
 */
export function buildDockerRunArgs(options: StartSandboxOptions): string[] {
  const { image, mountPath, env, secretEnvNames = [], mounts: extraMounts = [], id } = options;
  const mountArgs = [
    { hostPath: mountPath, containerPath: mountPath, mode: "rw" as const },
    ...extraMounts,
  ].flatMap((m) => buildMountFlag(m.hostPath, m.containerPath, m.mode));
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const secretArgs = secretEnvNames.flatMap((name) => ["-e", name]);

  return [
    "docker",
    "run",
    "-d",
    "--rm",
    "--init", // a real PID1 that forwards SIGTERM instead of `tail -f /dev/null` ignoring it
    "--pull",
    "never", // Crisol's image is always built locally — never let docker try a registry for it
    "--name",
    `crisol-${id}`,
    "--label",
    `crisol.run=${id}`,
    ...mountArgs,
    "-w",
    mountPath,
    ...envArgs,
    ...secretArgs,
    image,
    "tail",
    "-f",
    "/dev/null",
  ];
}

/**
 * `mountPath` bind-mounted at the same absolute path inside, plus whatever the
 * Adapter declared pre-start; `Sandbox.mounts` is exactly those pairs. Kept alive
 * with `tail -f /dev/null` (busybox has no `sleep infinity`) so later Adapter
 * calls can `exec` into it repeatedly.
 */
export async function startSandbox(options: StartSandboxOptions): Promise<Sandbox> {
  const { mountPath, mounts: extraMounts = [], secretEnv = {} } = options;
  const mounts = [
    formatMount(mountPath, mountPath, "rw"),
    ...extraMounts.map((m) => formatMount(m.hostPath, m.containerPath, m.mode)),
  ];

  const proc = Bun.spawn(buildDockerRunArgs(options), {
    // Secret values reach the container through THIS spawn's own env, never the
    // docker argv. `secretEnv` is merged in for this one spawn only — `process.env`
    // itself is never mutated.
    env: { ...process.env, ...secretEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`docker run failed: ${stderr.trim()}`);
  }
  const containerId = stdout.trim();

  return {
    containerId,
    mounts,
    async exec(cmd: string[]): Promise<ExecResult> {
      try {
        const execProc = Bun.spawn(["docker", "exec", containerId, ...cmd], {
          env: process.env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err, code] = await Promise.all([
          new Response(execProc.stdout).text(),
          new Response(execProc.stderr).text(),
          execProc.exited,
        ]);
        return { exitCode: code, stdout: out, stderr: err };
      } catch (error) {
        // `Bun.spawn` can throw synchronously (e.g. the docker binary vanishing from
        // PATH) — folded into the normal `ExecResult` shape so a caller never has to
        // handle "exec can also reject" as a separate case.
        const message = error instanceof Error ? error.message : String(error);
        return { exitCode: -1, stdout: "", stderr: message };
      }
    },
    async stop(): Promise<StopResult> {
      try {
        // `docker rm -f` kills and removes immediately — never the 10s SIGTERM grace
        // period `docker stop` would wait out against a PID1 that ignores SIGTERM.
        const stopProc = Bun.spawn(["docker", "rm", "-f", containerId], {
          env: process.env,
          stdout: "ignore",
          stderr: "pipe",
        });
        const [stopStderr, stopExitCode] = await Promise.all([
          new Response(stopProc.stderr).text(),
          stopProc.exited,
        ]);
        return { ok: stopExitCode === 0, stderr: stopStderr.trim() };
      } catch (error) {
        // Load-bearing: `run.ts` calls `stop()` from inside its own `finally` block,
        // and a throw from WITHIN a `finally` REPLACES whatever primary error was
        // propagating — silently masking it, and leaking the container. Caught here
        // so `stop()` always resolves to a normal `StopResult` instead.
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, stderr: message };
      }
    },
  };
}
