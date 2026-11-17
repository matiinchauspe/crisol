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

/** A named, long-lived Docker volume — unlike `MountSpec`, never torn down with the Run. */
export interface VolumeMountSpec {
  volume: string;
  containerPath: string;
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
 * Crisol's own Project layer: what a Run gets when the repo carries no `.crisol/Dockerfile`.
 * `bash` and `curl` round out the list for what the fake Adapter's own scripts and the Allowlist
 * probes need. `BUN_INSTALL=/usr/local` lands `bun` in a world-readable, already-on-`PATH`
 * directory, so the Agent layer's later non-root `USER agent` can still run it — verified live: a
 * `/root`-installed `bun` is unreadable to uid 1000, since `/root` is `0700`.
 */
export const DEFAULT_PROJECT_DOCKERFILE = [
  "FROM alpine:3.20",
  "RUN apk add --no-cache git bash curl nodejs npm python3 github-cli ripgrep",
  "ENV BUN_INSTALL=/usr/local",
  "RUN curl -fsSL https://bun.sh/install | bash",
  "",
].join("\n");

export const DEFAULT_PROJECT_IMAGE_TAG = "crisol-base:0.2.0";

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

export async function ensureDefaultProjectImage(tag: string = DEFAULT_PROJECT_IMAGE_TAG): Promise<string> {
  return ensureImageFromDockerfile(tag, DEFAULT_PROJECT_DOCKERFILE);
}

/** Short: enough to key a cache tag, not a security boundary. */
export function contentHash(parts: readonly string[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(parts.join("\u0000"));
  return hasher.digest("hex").slice(0, 12);
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
  volumeMounts?: readonly VolumeMountSpec[];
  /** Becomes the container's `--name crisol-<id>` and `--label crisol.run=<id>`. */
  id: string;
  network?: string;
  /** Joined after creation when it differs from `network`. */
  servicesNetwork?: string;
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

/** `docker run` auto-creates a named volume on first use — verified live — so there is no separate `ensureVolume`. */
function buildVolumeMountFlag(volume: string, containerPath: string): string[] {
  return ["--mount", `type=volume,source=${volume},target=${containerPath}`];
}

export function buildDockerRunArgs(options: StartSandboxOptions): string[] {
  const {
    image,
    mountPath,
    env,
    secretEnvNames = [],
    mounts: extraMounts = [],
    volumeMounts = [],
    id,
    network,
  } = options;
  const mountArgs = [
    { hostPath: mountPath, containerPath: mountPath, mode: "rw" as const },
    ...extraMounts,
  ].flatMap((m) => buildMountFlag(m.hostPath, m.containerPath, m.mode));
  const volumeMountArgs = volumeMounts.flatMap((v) => buildVolumeMountFlag(v.volume, v.containerPath));
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
    ...volumeMountArgs,
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

export async function connectNetwork(network: string, container: string): Promise<void> {
  const proc = Bun.spawn(["docker", "network", "connect", network, container], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    ...DETACHED,
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`docker network connect failed (${network} <- ${container}): ${stderr.trim()}`);
  }
}

function spawnFailure(error: unknown): ExecResult {
  return { exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
}

/** One detached, piped `docker` subcommand that never throws. */
export async function runDocker(args: string[]): Promise<ExecResult> {
  try {
    const proc = Bun.spawn(args, { env: process.env, stdout: "pipe", stderr: "pipe", ...DETACHED });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    return spawnFailure(error);
  }
}

/** By name, not by the shared label: a label sweep would also take the Sandbox, whose removal is reported apart. */
export async function removeContainerByName(name: string): Promise<StopResult> {
  const result = await runDocker(["docker", "rm", "-f", name]);
  if (result.exitCode === 0 || /no such container/i.test(result.stderr)) return { ok: true, stderr: "" };
  return { ok: false, stderr: result.stderr.trim() };
}

/** Never exposed to an Adapter, which must stay non-root. */
async function dockerExec(containerId: string, cmd: string[], opts: { stdin?: string; user?: string } = {}): Promise<ExecResult> {
  const { stdin, user } = opts;
  try {
    const execProc = Bun.spawn(
      [
        "docker",
        "exec",
        ...(user !== undefined ? ["-u", user] : []),
        ...(stdin === undefined ? [] : ["-i"]),
        containerId,
        ...cmd,
      ],
      {
        env: process.env,
        ...(stdin === undefined ? {} : { stdin: new Blob([stdin]) }),
        stdout: "pipe",
        stderr: "pipe",
        ...DETACHED,
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(execProc.stdout).text(),
      new Response(execProc.stderr).text(),
      execProc.exited,
    ]);
    return { exitCode: code, stdout: out, stderr: err };
  } catch (error) {
    // `Bun.spawn` throws synchronously when the binary is missing; callers handle one shape only.
    return spawnFailure(error);
  }
}

/** Root exists in every image, whatever `USER` it declares. */
export async function execAsRoot(containerId: string, cmd: string[]): Promise<ExecResult> {
  return dockerExec(containerId, cmd, { user: "root" });
}

/** Kept alive with `tail -f /dev/null` (busybox has no `sleep infinity`) so the Adapter can `exec` into it repeatedly. */
export async function startSandbox(options: StartSandboxOptions): Promise<Sandbox> {
  const { mountPath, mounts: extraMounts = [], secretEnv = {}, network, servicesNetwork } = options;
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

  // Docker refuses to mix the default bridge with a user-defined network in one `--network` list
  // (verified live), so open mode's internet-carrying bridge and a bare Services network can only
  // combine by joining the second one after creation.
  if (servicesNetwork !== undefined && servicesNetwork !== network) {
    await connectNetwork(servicesNetwork, containerId);
  }

  return {
    containerId,
    mounts,
    exec(cmd: string[], stdin?: string): Promise<ExecResult> {
      return dockerExec(containerId, cmd, { stdin });
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
