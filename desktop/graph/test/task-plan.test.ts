import { expect, test } from "bun:test";
import { type GraphTask, parseTaskPlan } from "../task-plan";

function task(id: string, files: string[], dependsOn: string[] = []): GraphTask {
	return { id, title: `Task ${id}`, brief: `Change ${files.join(", ")}`, dependsOn, files };
}

test("orders prerequisites first regardless of proposal order", () => {
	const plan = parseTaskPlan({
		tasks: [
			task("ui", ["src/frontend.txt"], ["api"]),
			task("docs", ["docs/api.md"], ["ui", "api"]),
			task("api", ["src/backend.txt"]),
		],
	});
	expect(plan.tasks.map(entry => entry.id)).toEqual(["api", "ui", "docs"]);
});

test("a task may own a file the repository does not have yet", () => {
	const plan = parseTaskPlan({ tasks: [task("new", ["src/brand-new/module.ts"])] });
	expect(plan.tasks[0].files).toEqual(["src/brand-new/module.ts"]);
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
	[
		"two tasks writing one file",
		[task("a", ["src/backend.txt"]), task("b", ["src/backend.txt"])],
		/a and b both write src\/backend.txt/,
	],
	[
		"two tasks writing case variants of one file",
		[task("a", ["src/backend.txt"]), task("b", ["SRC/Backend.txt"])],
		/a and b both write SRC\/Backend.txt/,
	],
	["a repeated task id", [task("a", ["src/backend.txt"]), task("a", ["docs/api.md"])], /repeats task a/],
	["a parent traversal", [task("a", ["src/../src/backend.txt"])], /portable/],
	["an absolute Windows path", [task("a", ["C:/repo/src/backend.txt"])], /portable/],
	["a Windows short-name alias", [task("a", ["src/BACKEN~1.TXT"])], /short-name alias/],
] as const)("rejects %s", (_name, tasks, error) => {
	expect(() => parseTaskPlan({ tasks })).toThrow(error);
});
