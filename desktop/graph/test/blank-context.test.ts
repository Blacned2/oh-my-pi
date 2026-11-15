import { expect, test } from "bun:test";
import { restoreBlankContextLines } from "../workspace";

const header = "diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n";

test("an empty line inside a hunk that still expects lines becomes a blank context line", () => {
	expect(restoreBlankContextLines(`${header}@@ -1,3 +1,3 @@\n one\n\n-three\n+3\n`)).toBe(
		`${header}@@ -1,3 +1,3 @@\n one\n \n-three\n+3\n`,
	);
});

test("a hunk header without counts expects one line on each side", () => {
	expect(restoreBlankContextLines(`${header}@@ -1 +1 @@\n\n`)).toBe(`${header}@@ -1 +1 @@\n \n`);
	expect(restoreBlankContextLines(`${header}@@ -1 +1 @@\n-a\n+b\n\n`)).toBe(`${header}@@ -1 +1 @@\n-a\n+b\n\n`);
});

test("blank lines after the last hunk and between file sections are left alone", () => {
	const second = "diff --git a/other.txt b/other.txt\n--- a/other.txt\n+++ b/other.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n";
	const patch = `${header}@@ -1,2 +1,2 @@\n one\n-two\n+2\n\n${second}\n`;
	expect(restoreBlankContextLines(patch)).toBe(patch);
});

test("an empty line where only one side still expects lines is not treated as context", () => {
	const patch = `${header}@@ -1,2 +1,1 @@\n one\n\n`;
	expect(restoreBlankContextLines(patch)).toBe(patch);
});
