export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** One extra bind mount an Adapter declares pre-start (ticket 15's Tenaza config/state; Adapter-split fix). */
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
  /** The exact `<host path>:<container path>[:ro]` triples this Sandbox was started with — logged by `run.ts` as the one source of truth for "what did we actually mount" (ticket 01's own proof that no host path besides the Clone, plus whatever the Adapter declared, is ever mounted). */
  readonly mounts: readonly string[];
  exec(cmd: string[]): Promise<ExecResult>;
  /** Tears the Sandbox down and reports whether that actually succeeded — `run.ts` must never log "stopped" when this reports `ok: false` (fix W1). */
  stop(): Promise<StopResult>;
}

/**
 * Crisol's embedded base image for the walking skeleton (ticket 01): just
 * enough for the fake Adapter to edit a file and commit — `git` and `bash`
 * on Alpine, nothing else. This is deliberately NOT the spec's full
 * Project + Agent layering (Node, Bun, Python, gh, rg, the agent CLI,
 * Tenaza's hooks — "Image and dependencies" q3/q17); see
 * docs/adr/0002-ticket-01-sandbox-image-is-a-placeholder.md.
 */
export const SKELETON_DOCKERFILE = "FROM alpine:3.20\nRUN apk add --no-cache git bash\n";

export const SKELETON_IMAGE_TAG = "crisol-base:0.1.0-skeleton";

function run(args: string[]): ExecResult {
  // Explicit `env: process.env`, same reasoning as git.ts's helper: without
  // it, `Bun.spawnSync` would miss any env mutation made at runtime within
  // this same process (e.g. a test pinning `DOCKER_HOST`).
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
 * Fails with a plain message, before any side effect, when the Docker
 * engine itself is unreachable (fix W5) — spec, "Capacity" q11: "An
 * unreachable engine fails with a plain message ..., not a socket error."
 *
 * Also catches the `docker` CLI binary itself being missing from PATH
 * (round-2 review extra): `Bun.spawnSync(["docker", ...])` THROWS
 * synchronously with an ENOENT error in that case, rather than returning a
 * normal non-zero exit code — left uncaught, that raw spawn error ("
 * Executable not found in $PATH: \"docker\"") would leak straight to the
 * user instead of Crisol's own plain, actionable message.
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

/**
 * Builds the embedded base image once per host and reuses it on every
 * later Run — `docker image inspect` is the whole cache key for this
 * placeholder image (the spec's real content-hash cache, keyed on the
 * Project + Agent layers, is later work).
 */
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
  /** The Clone's absolute path, bind-mounted at the SAME path inside (spec q6). */
  mountPath: string;
  /** Non-secret env, embedded directly in argv as `KEY=value` (git identity, etc.) — never a secret. */
  env: Record<string, string>;
  /**
   * Declared secret env var NAMES (Adapter-split fix; ticket 08's shape) —
   * never values. Passed to `docker run` as a bare `-e NAME`; docker then
   * reads the VALUE from the spawned `docker` process's own environment,
   * so a secret's value is never written to the docker argv (visible in
   * `ps`, shell history, or this process's own logs).
   */
  secretEnvNames?: readonly string[];
  /** Extra mounts an Adapter declares pre-start (ticket 15's Tenaza config/state) — empty for the fake Adapter. */
  mounts?: readonly MountSpec[];
  /** The Run id — becomes the container's `--name crisol-<id>` and `--label crisol.run=<id>` (fix W1). */
  id: string;
}

/**
 * The human-readable `host:container[:ro]` summary Crisol uses for its OWN
 * bookkeeping — `Sandbox.mounts` and the Run log (ticket 01's own proof of
 * "what did we actually mount"). Deliberately NOT what gets passed to
 * `docker run` itself; see `buildMountFlag` for that.
 */
function formatMount(hostPath: string, containerPath: string, mode: "ro" | "rw"): string {
  return mode === "ro" ? `${hostPath}:${containerPath}:ro` : `${hostPath}:${containerPath}`;
}

/**
 * The actual `--mount` flag docker run receives (extra: `--mount` over the
 * older `-v`/`--volume` short syntax — `--mount`'s explicit `type=bind,
 * source=,target=` keys are unambiguous about what's being requested,
 * where `-v`'s colon-separated shorthand has historically been a source of
 * parsing surprises, e.g. around paths or options that themselves contain
 * a colon).
 */
function buildMountFlag(hostPath: string, containerPath: string, mode: "ro" | "rw"): string[] {
  const spec = `type=bind,source=${hostPath},target=${containerPath}${mode === "ro" ? ",readonly" : ""}`;
  return ["--mount", spec];
}

/**
 * Builds the `docker run` argv as a pure function of its inputs — unit
 * tested on its own (no Docker needed) specifically to prove secrets never
 * appear as a VALUE on the argv, only as a bare `-e NAME` (Adapter-split
 * fix). `startSandbox` is the only caller that actually spawns it.
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
    "--init", // a real PID1 that forwards SIGTERM instead of `tail -f /dev/null` ignoring it (fix W1)
    "--pull",
    "never", // extra: Crisol's image is always built locally — never let docker try a registry for it
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
 * Starts the Run's Sandbox: a container built from `image`, with
 * `mountPath` bind-mounted at the SAME absolute path inside (spec q6) plus
 * whatever the Adapter declared pre-start (`mounts`, `secretEnvNames`) —
 * `mounts` on the returned `Sandbox` is exactly, and only, those pairs.
 * Kept alive with `tail -f /dev/null` (busybox has no `sleep infinity`) so
 * the Adapter's runtime points can `exec` into it repeatedly across the Run.
 */
export async function startSandbox(options: StartSandboxOptions): Promise<Sandbox> {
  const { mountPath, mounts: extraMounts = [] } = options;
  const mounts = [
    formatMount(mountPath, mountPath, "rw"),
    ...extraMounts.map((m) => formatMount(m.hostPath, m.containerPath, m.mode)),
  ];

  const proc = Bun.spawn(buildDockerRunArgs(options), {
    // Secret values reach the container through THIS process's own env
    // (never the docker argv) — `secretEnvNames` only ever supplies bare
    // names to `-e`, and docker resolves each one from here.
    env: process.env,
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
        // Round-3 review, finding 3 (CONFIRMED): `Bun.spawn` can THROW
        // synchronously (e.g. the `docker` binary vanishing from PATH),
        // same risk `assertDockerReachable`'s own `isEnoent` catch already
        // guards for its one pre-check call. Folded into the normal
        // `ExecResult` shape here so a caller never has to handle "exec can
        // also reject" as a separate case from any other docker failure.
        const message = error instanceof Error ? error.message : String(error);
        return { exitCode: -1, stdout: "", stderr: message };
      }
    },
    async stop(): Promise<StopResult> {
      try {
        // `docker rm -f` kills (SIGKILL) and removes immediately — never
        // the 10s SIGTERM grace period `docker stop` would wait out against
        // a `tail -f /dev/null` PID1 that ignores SIGTERM (fix W1).
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
        // Round-3 review, finding 3 (CONFIRMED): same spawn-throw risk as
        // `exec` above — but here it's load-bearing. `run.ts` calls
        // `sandbox.stop()` from inside its OWN `finally` block (fix W1),
        // and a throw from WITHIN a `finally` always REPLACES whatever
        // primary error (e.g. an Adapter failure) was already propagating —
        // silently masking it, AND leaking the container (never actually
        // removed). Caught here so `stop()` always resolves to a normal
        // `StopResult` — `run.ts`'s existing `stopResult.ok` check already
        // logs a failed teardown without ever threatening the primary error.
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, stderr: message };
      }
    },
  };
}
