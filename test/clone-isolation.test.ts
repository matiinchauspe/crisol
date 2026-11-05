import { describe, expect, test } from "bun:test";
import { createFixtureRepo } from "./support/fixtureRepo";
import { createTempHome } from "./support/crisolHome";
import { run } from "../src/run";
import { FakeAdapter } from "../src/adapters/fake";

/**
 * C1 (CRITICAL, decided by Matías): the Clone must not share object inodes
 * with the host. Originally fixed with `git clone --local --no-hardlinks`
 * (that flag forced a real copy instead of a hardlink); superseded by
 * `--no-local file://` (see docs/adr/0004's second amendment, finding 9),
 * which removes the filesystem fast-path entirely — the Clone's objects
 * always arrive via git's normal pack-transfer negotiation, never sharing
 * an inode with the host's regardless of `--no-hardlinks`. This test still
 * proves the underlying property: an object a Sandbox corrupts in the
 * Clone must never corrupt the host. Since `--no-local` delivers objects
 * packed (even a one-commit repo clones into a single `.pack`, never loose
 * files), the script first forces the target object OUT of its pack and
 * into a loose file — the only form a single `chmod`+overwrite can
 * meaningfully corrupt — before corrupting it.
 */
describe("Clone object-store isolation from the host (C1)", () => {
  test("overwriting an object file inside the Sandbox's Clone never corrupts the host repo", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const blobSha = Bun.spawnSync(["git", "-C", repo.path, "rev-parse", "HEAD:README.md"], {
        stdout: "pipe",
      })
        .stdout.toString("utf8")
        .trim();
      expect(blobSha).toHaveLength(40);
      const objectRelPath = `.git/objects/${blobSha.slice(0, 2)}/${blobSha.slice(2)}`;

      // A fake-Adapter script run INSIDE the Sandbox that first forces the
      // README blob out of the Clone's pack (unpack-objects skips writing a
      // loose copy of an object it can already satisfy from a pack, so the
      // pack has to be moved out of `objects/pack/` before re-feeding it)
      // and into a loose file, then overwrites that file directly.
      const corruptingScript = [
        "mkdir -p /tmp/pack-backup && cp .git/objects/pack/*.pack /tmp/pack-backup/",
        "rm .git/objects/pack/*.pack .git/objects/pack/*.idx",
        'for p in /tmp/pack-backup/*.pack; do git unpack-objects < "$p"; done',
        `chmod u+w ${objectRelPath}`,
        `printf 'corrupted-by-sandbox' > ${objectRelPath}`,
      ];

      const result = await run({
        task: "corrupt an object from inside the Sandbox",
        cwd: repo.path,
        home: home.path,
        adapter: new FakeAdapter(corruptingScript),
      });
      expect(result.status).toBe("unverified");

      // The HOST repo must still be entirely healthy.
      const fsck = Bun.spawnSync(["git", "-C", repo.path, "fsck", "--full"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const fsckOutput = fsck.stdout.toString("utf8") + fsck.stderr.toString("utf8");
      expect(fsck.exitCode).toBe(0);
      expect(fsckOutput).not.toContain("corrupt");

      // And the host's own copy of the blob must still read back its real content.
      const catFile = Bun.spawnSync(["git", "-C", repo.path, "cat-file", "-p", blobSha], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(catFile.exitCode).toBe(0);
      expect(catFile.stdout.toString("utf8")).toBe("# fixture\n");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});
