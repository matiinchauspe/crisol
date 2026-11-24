import { describe, expect, test } from "bun:test";
import { FakeAdapter } from "../src/adapters/fake";
import { declarationChangeWarning } from "../src/declaration-warning";
import { run } from "../src/run";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";

function commitDeclaration(file: string, content: string): string[] {
  return [
    `mkdir -p .crisol && printf '%s\\n' '${content}' > ${file}`,
    `git add ${file}`,
    `git commit --quiet -m 'chore: declare something'`,
  ];
}

describe("declarationChangeWarning names the file and who reads it", () => {
  test("the message says a Run cut from the branch reads it, as the merged repo does", () => {
    const warning = declarationChangeWarning(".crisol/Dockerfile", "it is built");
    expect(warning).toContain(".crisol/Dockerfile");
    expect(warning).toContain("a Run cut from this branch, or the repo once it is merged");
  });
});

describe("a branch that changes a .crisol/ declaration is flagged", () => {
  const cases = [
    { file: ".crisol/config.toml", content: 'secrets = ["GITHUB_TOKEN"]' },
    { file: ".crisol/Dockerfile", content: "FROM scratch" },
    { file: ".crisol/services.yml", content: "services: {}" },
  ];

  for (const { file, content } of cases) {
    test(`a commit to ${file} carries a warning naming it`, async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const result = await run({
          task: "x",
          cwd: repo.path,
          home: home.path,
          adapter: new FakeAdapter(commitDeclaration(file, content)),
        });
        const named = result.warnings.filter((entry) => entry.includes(file));
        expect(named).toHaveLength(1);
        expect(named[0]).toContain("a Run cut from this branch");
        expect(result.warnings.filter((entry) => entry.includes(".crisol/") && !entry.includes(file))).toEqual([]);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    }, 60_000);
  }

  test("a branch that leaves .crisol/ alone carries none of them", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await run({ task: "x", cwd: repo.path, home: home.path });
      expect(result.warnings.filter((entry) => entry.includes(".crisol/"))).toEqual([]);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});
