import { acquireSlot } from "../../src/slots";

const home = process.argv[2]!;
const slot = await acquireSlot({ home, maxParallel: 1 });
const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
process.stdout.write(`held ${slot.index}\nchild ${child.pid}\n`);
await Bun.sleep(60_000);
