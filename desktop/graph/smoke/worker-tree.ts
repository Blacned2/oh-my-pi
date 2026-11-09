import * as path from "node:path";

const home = Bun.env.HOME;
if (!home) throw new Error("Graph smoke home is missing");
const cliPath = await Bun.file(path.join(home, "smoke-cli-path")).text();
const child = Bun.spawn([process.execPath, "--no-env-file", cliPath, ...Bun.argv.slice(2)], {
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
	windowsHide: true,
});
await Bun.write(path.join(home, "smoke-processes.json"), JSON.stringify([process.pid, child.pid]));
process.exitCode = await child.exited;
