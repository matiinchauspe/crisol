import { tryLockRun } from "../../src/slots";

// Stands in for `crisol recover` holding a dead Run's lock while it works.
const held = tryLockRun(process.argv[2]!);
process.stdout.write(held ? "held\n" : "busy\n");
await Bun.sleep(60_000);
