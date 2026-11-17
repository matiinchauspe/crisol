export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

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
  readonly mounts: readonly string[];
  /** `stdin`, not argv, carries text of any size: Linux caps one argv string at 128 KiB. */
  exec(cmd: string[], stdin?: string): Promise<ExecResult>;
  /** Reports whether teardown actually succeeded — callers must never log "stopped" when `ok` is false. */
  stop(): Promise<StopResult>;
}

/**
 * The Project layer: a placeholder until Crisol reads a repo's own `.crisol/Dockerfile`.
 * `curl` lets a Sandbox probe the network from inside itself.
 */
export const SKELETON_DOCKERFILE = "FROM alpine:3.20\nRUN apk add --no-cache git bash curl\n";

export const SKELETON_IMAGE_TAG = "crisol-base:0.1.1-skeleton";

/**
 * Every `docker` child a Run makes leads its own session: a Ctrl+C or hang-up aimed at
 * Crisol's process group must not kill a `docker run` mid-create or a `docker rm` mid-teardown,
 * leaving a container nobody removes. Crisol's own handlers decide what a signal stops.
 */
const DETACHED = { detached: true } as const;

function run(args: string[]): ExecResult {
  // Without it, `Bun.spawnSync` sees the env as it was at process start, not later mutations.
  const proc = Bun.spawnSync(args, { env: process.env, stdout: "pipe", stderr: "pipe", ...DETACHED });
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

/** A missing `docker` binary makes `Bun.spawnSync` throw ENOENT rather than exit non-zero. */
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

/** No build context: the Dockerfile arrives over stdin, so it cannot `COPY`. */
export async function ensureImageFromDockerfile(tag: string, dockerfile: string): Promise<string> {
  if (imageExists(tag)) return tag;

  // Not detached: it runs in pre-flight, before the Run has anything to tear down, so a Ctrl+C
  // should kill the build at once.
  const proc = Bun.spawn(["docker", "build", "-q", "-t", tag, "-"], {
    stdin: new Blob([dockerfile]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`docker build failed for ${tag}: ${stderr.trim()}`);
  }
  return tag;
}

export async function ensureBaseImage(tag: string = SKELETON_IMAGE_TAG): Promise<string> {
  return ensureImageFromDockerfile(tag, SKELETON_DOCKERFILE);
}

export interface StartSandboxOptions {
  image: string;
  /** Bind-mounted at the same absolute path inside. */
  mountPath: string;
  /** Lands on the docker argv, visible in `ps` — never a secret. */
  env: Record<string, string>;
  /**
   * NAMES only: a bare `-e NAME` makes docker read the value from its own environment, so a
   * secret never lands on the argv.
   */
  secretEnvNames?: readonly string[];
  /** Merged into the spawned docker CLI's env only, never into `process.env` or the argv. */
  secretEnv?: Record<string, string>;
  mounts?: readonly MountSpec[];
  /** Becomes the container's `--name crisol-<id>` and `--label crisol.run=<id>`. */
  id: string;
  network?: string;
}

/** For the log only; `buildMountFlag` is what reaches `docker run`. */
function formatMount(hostPath: string, containerPath: string, mode: "ro" | "rw"): string {
  return mode === "ro" ? `${hostPath}:${containerPath}:ro` : `${hostPath}:${containerPath}`;
}

/** `--mount`, because `-v`'s colon-separated shorthand misparses a path containing a colon. */
function buildMountFlag(hostPath: string, containerPath: string, mode: "ro" | "rw"): string[] {
  const spec = `type=bind,source=${hostPath},target=${containerPath}${mode === "ro" ? ",readonly" : ""}`;
  return ["--mount", spec];
}

export function buildDockerRunArgs(options: StartSandboxOptions): string[] {
  const { image, mountPath, env, secretEnvNames = [], mounts: extraMounts = [], id, network } = options;
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
    ...(network !== undefined ? ["--network", network] : []),
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

/** Kept alive with `tail -f /dev/null` (busybox has no `sleep infinity`) so the Adapter can `exec` into it repeatedly. */
export async function startSandbox(options: StartSandboxOptions): Promise<Sandbox> {
  const { mountPath, mounts: extraMounts = [], secretEnv = {} } = options;
  const mounts = [
    formatMount(mountPath, mountPath, "rw"),
    ...extraMounts.map((m) => formatMount(m.hostPath, m.containerPath, m.mode)),
  ];

  const proc = Bun.spawn(buildDockerRunArgs(options), {
    env: { ...process.env, ...secretEnv },
    stdout: "pipe",
    stderr: "pipe",
    ...DETACHED,
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
    async exec(cmd: string[], stdin?: string): Promise<ExecResult> {
      try {
        const execProc = Bun.spawn(["docker", "exec", ...(stdin === undefined ? [] : ["-i"]), containerId, ...cmd], {
          env: process.env,
          ...(stdin === undefined ? {} : { stdin: new Blob([stdin]) }),
          stdout: "pipe",
          stderr: "pipe",
          ...DETACHED,
        });
        const [out, err, code] = await Promise.all([
          new Response(execProc.stdout).text(),
          new Response(execProc.stderr).text(),
          execProc.exited,
        ]);
        return { exitCode: code, stdout: out, stderr: err };
      } catch (error) {
        // `Bun.spawn` throws synchronously when the binary is missing; callers handle one shape only.
        const message = error instanceof Error ? error.message : String(error);
        return { exitCode: -1, stdout: "", stderr: message };
      }
    },
    stop(): Promise<StopResult> {
      return removeContainers([containerId]);
    },
  };
}

/**
 * `docker rm -f`, never `docker stop`, which waits out a 10s grace period. Never rejects: a
 * caller tearing down after a failure must not have that failure replaced by this one.
 */
async function removeContainers(containers: readonly string[]): Promise<StopResult> {
  try {
    const proc = Bun.spawn(["docker", "rm", "-f", ...containers], {
      env: process.env,
      stdout: "ignore",
      stderr: "pipe",
      ...DETACHED,
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { ok: exitCode === 0, stderr: stderr.trim() };
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Removes every container labelled `crisol.run=<id>`, running or not. The label still finds a
 * Sandbox whose handle was lost — a `docker run` interrupted mid-create, or a Run that died.
 * Resolves `ok` with nothing to remove.
 */
export async function removeRunSandboxes(id: string): Promise<StopResult & { removed: number }> {
  let listed: ExecResult;
  try {
    listed = run(["docker", "ps", "-aq", "--filter", `label=crisol.run=${id}`]);
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error), removed: 0 };
  }
  if (listed.exitCode !== 0) return { ok: false, stderr: listed.stderr.trim(), removed: 0 };
  const containers = listed.stdout.split("\n").filter(Boolean);
  if (containers.length === 0) return { ok: true, stderr: "", removed: 0 };
  return { ...(await removeContainers(containers)), removed: containers.length };
}

/** Run ids that still have a container, running or not; `undefined` when Docker cannot be asked. */
export function listRunSandboxIds(): Set<string> | undefined {
  let listed: ExecResult;
  try {
    listed = run(["docker", "ps", "-a", "--filter", "label=crisol.run", "--format", '{{.Label "crisol.run"}}']);
  } catch {
    return undefined;
  }
  if (listed.exitCode !== 0) return undefined;
  return new Set(listed.stdout.split("\n").filter(Boolean));
}
