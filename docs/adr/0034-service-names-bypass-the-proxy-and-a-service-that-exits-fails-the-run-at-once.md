# Service names bypass the proxy, and a Service that exits fails the Run at once

Ticket 38. Two gaps in ADR 0015's Services, found by review over the 0.1.0 deliverable.

- **A Service was unreachable through the proxy.** ADR 0012 set `NO_PROXY` to
  `localhost,127.0.0.1`, written before Services existed. Any tool that honours `HTTP_PROXY`
  (curl, npm, pip, git) sent `http://<service>:<port>/` to tinyproxy, which refused it as off the
  Allowlist. A raw TCP probe, the only kind ADR 0015's tests used, never goes through the proxy,
  so the gap went unseen.
- **A crashed Service hung the wait.** Service containers ran with `--rm`. One that exited was
  removed, `docker inspect` then failed, and `waitHealthy` treated that as neither healthy nor
  unhealthy, polling until its 10-minute backstop.

## Every declared Service name joins `NO_PROXY`

`startNetworkWall` takes the Run's Service names, and `buildProxyEnv` appends them to
`localhost,127.0.0.1`, both casings as before. A Service lives on the Run's own internal network,
so the Sandbox reaches it directly. Through the proxy it is refused in allowlist mode, and learn
mode has no reason to carry it either, so the same list applies there. Open mode sets no proxy env
at all.

The names are passed in rather than read from the Service containers, because the wall goes up
before the Services do: `services.yml` is read before either.

## Service containers outlive their own exit, and the wait reads `State.Status` first

`--rm` is dropped, so an exited Service stays inspectable until the Run's teardown, whose
`docker rm -f` by name already removes a stopped container. `crisol recover`'s label sweep is
`docker ps -a`, so it covers a stopped Service of a dead Run too.

Each poll now reads `{{.State.Status}} {{.State.ExitCode}}` and the health status together. An
`exited` or `dead` Service fails the wait at once with its exit code and the last 20 lines of
`docker logs`. Status comes first because Docker also reports an exited container's health as
`unhealthy`, verified live (`exited 3 unhealthy`). A Service that is gone (`no such object`, the
daemon's message, verified live) fails the wait too. Any other inspect failure is retried on the
next poll, as before.

`docker logs` writes the container's stdout and stderr to separate streams, so the message prints
the stdout lines first and the stderr lines after, losing their order.

Only a Service with a healthcheck is watched. One without has no healthy state to wait for, and a
Service that exits 0 on purpose, such as a one-shot setup job, must not fail the Run.

Rejected:
- **Keeping `--rm` and reading the exit from `docker wait` or events**: the logs, which tell the
  human why it exited, are gone with the container.
- **Reading the names off the Service containers' aliases**: the wall is built first, so the proxy
  env would have to be patched after the fact.
