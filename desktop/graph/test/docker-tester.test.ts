import { expect, test } from "bun:test";
import { captureOutput, type DockerTestProfile, validateDockerProfile } from "../docker-tester";

const encoder = new TextEncoder();

function streamOf(text: string, chunkSize: number): ReadableStream<Uint8Array> {
	const bytes = encoder.encode(text);
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= bytes.byteLength) return controller.close();
			controller.enqueue(bytes.slice(offset, offset + chunkSize));
			offset += chunkSize;
		},
	});
}

test("short test output is kept unchanged, multi-byte characters included", async () => {
	const output = "ok 1 – passed €\n".repeat(100);
	expect(await captureOutput(streamOf(output, 7))).toBe(output);
});

test("long test output keeps the head and the failure summary at the end, with the omitted byte count", async () => {
	// 3-byte characters put both cut points inside a character: neither may decode to U+FFFD.
	const output = `${"€".repeat(40_000)}z`;
	const captured = await captureOutput(streamOf(output, 1000));
	// Head: 16384 bytes hold 5461 whole characters; tail: 49152 bytes start 2 bytes into a character.
	const omitted = 120_001 - 5461 * 3 - (49_152 - 2);
	expect(captured).toBe(`${"€".repeat(5461)}\n[… ${omitted} bytes omitted …]\n${"€".repeat(16_383)}z`);
	expect(captured).not.toContain("\uFFFD");
});

test("a deadline keeps the output read so far instead of discarding it", async () => {
	const controller = new AbortController();
	let reads = 0;
	// A hung test: one line, then nothing until the deadline fires on the next read.
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(source) {
				if (reads++ === 0) source.enqueue(encoder.encode("partial progress\n"));
				else controller.abort(new Error("deadline"));
			},
		},
		{ highWaterMark: 0 },
	);
	expect(await captureOutput(stream, controller.signal)).toBe("partial progress\n");
});

test("profile validation names the first invalid field", () => {
	const valid: DockerTestProfile = {
		dockerPath: process.platform === "win32" ? "C:\\Docker\\docker.exe" : "/usr/bin/docker",
		imageId: `sha256:${"a".repeat(64)}`,
		command: ["/bin/sh", "-c", "true"],
		timeoutMs: 60_000,
	};
	expect(() => validateDockerProfile(valid)).not.toThrow();
	expect(() => validateDockerProfile({ ...valid, dockerPath: "docker" })).toThrow(/dockerPath/);
	expect(() => validateDockerProfile({ ...valid, imageId: "alpine:latest" })).toThrow(/imageId/);
	expect(() => validateDockerProfile({ ...valid, command: ["sh"] })).toThrow(/command\[0\]/);
	expect(() => validateDockerProfile({ ...valid, timeoutMs: 300_001 })).toThrow(/timeoutMs/);
	expect(() => validateDockerProfile({ ...valid, dockerPath: "docker", timeoutMs: 0 })).toThrow(/dockerPath/);
});
