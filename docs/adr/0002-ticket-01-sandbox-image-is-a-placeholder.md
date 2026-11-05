# Ticket 01's Sandbox image is a placeholder, not the spec's full base image

The embedded Dockerfile (`src/docker.ts`'s `SKELETON_DOCKERFILE`) is `FROM alpine:3.20` plus `git`
and `bash` only — enough for the fake Adapter's scripted edit-and-commit, nothing from the spec's
full Project layer (Node, Bun, Python, gh, rg) or Agent layer (the agent CLI, Tenaza's hooks —
"Image and dependencies" q3/q17). Chosen to keep the walking skeleton's own build fast and its only
claim honest: this ticket proves the Clone → Sandbox → commit → Fetch-back path, not the final
image. A later ticket replaces `SKELETON_DOCKERFILE` / `SKELETON_IMAGE_TAG` and their one-tag cache
with the real two-layer build and its content-hash cache (Project layer image + agent version +
Tenaza version); nothing here should be read as that design, and no caller outside `docker.ts`
should name this image's tag directly.
