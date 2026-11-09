import { expect, test } from "bun:test";
import { type GraphTask, parseTaskPlan } from "../task-plan";
import { parseApprovedGraphInput } from "../workflow";

const approved = ["src/backend.txt", "src/frontend.txt", "docs/api.md"];

function task(id: string, files: string[], dependsOn: string[] = []): GraphTask {
	return { id, title: `Task ${id}`, brief: `Change ${files.join(", ")}`, dependsOn, files };
}

test("orders prerequisites first regardless of proposal order", () => {
	const plan = parseTaskPlan(
		{
			tasks: [
				task("ui", ["src/frontend.txt"], ["api"]),
				task("docs", ["docs/api.md"], ["ui", "api"]),
				task("api", ["src/backend.txt"]),
			],
		},
		approved,
	);
	expect(plan.tasks.map(entry => entry.id)).toEqual(["api", "ui", "docs"]);
});

test.each([
	["an unknown dependency", [task("ui", ["src/frontend.txt"], ["api"])], /unknown task api/],
	["a self dependency", [task("ui", ["src/frontend.txt"], ["ui"])], /depends on itself/],
	[
		"a dependency cycle",
		[
			task("a", ["src/backend.txt"], ["c"]),
			task("b", ["src/frontend.txt"], ["a"]),
			task("c", ["docs/api.md"], ["b"]),
		],
		/cycle: a → c → b → a/,
	],
	["a path outside the approved scope", [task("a", ["src/secret.txt"])], /outside the approved scope/],
	["a case variant of an approved file", [task("a", ["SRC/Backend.txt"])], /resolves to approved src\/backend.txt/],
	[
		"two tasks writing one file",
		[task("a", ["src/backend.txt"]), task("b", ["src/backend.txt"])],
		/a and b both write src\/backend.txt/,
	],
	["a repeated task id", [task("a", ["src/backend.txt"]), task("a", ["docs/api.md"])], /repeats task a/],
	["a parent traversal", [task("a", ["src/../src/backend.txt"])], /portable/],
] as const)("rejects %s", (_name, tasks, error) => {
	expect(() => parseTaskPlan({ tasks }, approved)).toThrow(error);
});

test("rejects a Windows short-name alias in the approved scope", () => {
	expect(() =>
		parseApprovedGraphInput({ source: "C:\\repo", objective: "Edit", files: ["src/BACKEN~1.TXT"] }),
	).toThrow(/short-name alias/);
});
