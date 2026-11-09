import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { importAuthCredentials } from "@oh-my-pi/pi-coding-agent/commands/auth";
import {
	buildWorkerOsImport,
	readWorkerOsAccounts,
	SETUP_TOKEN_TTL_MS,
	unsealWorkerOsAccounts,
} from "@oh-my-pi/pi-coding-agent/commands/auth-workeros";
import { TempDir } from "@oh-my-pi/pi-utils";

const TOKEN_A = `sk-ant-oat01-${"a".repeat(60)}`;
const TOKEN_B = `sk-ant-oat01-${"b".repeat(60)}`;
const TOKEN_C = `sk-ant-oat01-${"c".repeat(60)}`;

function writeSidecarDb(file: string, runtime: unknown): void {
	const db = new Database(file);
	db.run("CREATE TABLE Setting (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt TEXT)");
	db.query("INSERT INTO Setting (key, value) VALUES (?, ?)").run("sidecar.runtime", JSON.stringify(runtime));
	db.close();
}

const noIdentity = async () => ({});

describe("omp auth import-workeros", () => {
	it("imports every Worker OS Claude account as its own anthropic row, opening sealed tokens", async () => {
		using dir = TempDir.createSync("@omp-auth-workeros-");
		const sidecar = path.join(dir.path(), "sidecar.db");
		writeSidecarDb(sidecar, {
			headless: {
				oauthToken: "dpapi:A",
				activeAccountId: "acc-3",
				accounts: [
					{ id: "default", name: "One@Example.com", token: "dpapi:A" },
					{ id: "acc-2", name: "two@example.com", token: `${TOKEN_B.slice(0, 30)}\n${TOKEN_B.slice(30)}` },
					{ id: "acc-3", name: "work laptop", token: "dpapi:C" },
					{ id: "acc-4", name: "broken", token: "dpapi:X" },
				],
			},
		});

		const sealed = readWorkerOsAccounts(sidecar);
		expect(sealed.find(account => account.active)?.id).toBe("acc-3");
		const opened = await unsealWorkerOsAccounts(sealed, async values =>
			values.map(value => (value === "A" ? TOKEN_A : value === "C" ? TOKEN_C : "")),
		);
		const now = 1_800_000_000_000;
		const plan = await buildWorkerOsImport(opened, { now, resolveIdentity: noIdentity });

		expect(plan.report.map(line => [line.name, line.imported, line.reason])).toEqual([
			["One@Example.com", true, undefined],
			["two@example.com", true, undefined],
			["work laptop", true, undefined],
			["broken", false, "token could not be decrypted"],
		]);

		const store = await SqliteAuthCredentialStore.open(path.join(dir.path(), "agent.db"));
		try {
			await importAuthCredentials(store, plan.data);
			const rows = store.listAuthCredentials("anthropic").map(row => row.credential as OAuthCredential);
			expect(rows.map(row => [row.access, row.email, row.accountId])).toEqual([
				[TOKEN_A, "one@example.com", undefined],
				[TOKEN_B, "two@example.com", undefined],
				[TOKEN_C, undefined, "workeros:acc-3"],
			]);
			// Setup-tokens cannot refresh: no refresh token, valid for a year.
			expect(rows.every(row => row.refresh === "" && row.expires === now + SETUP_TOKEN_TTL_MS)).toBe(true);

			// Re-running the import replaces the same accounts instead of duplicating them.
			await importAuthCredentials(store, plan.data);
			expect(store.listAuthCredentials("anthropic")).toHaveLength(3);
		} finally {
			store.close();
		}
	});

	it("prefers the identity Anthropic reports over the Worker OS account name", async () => {
		const plan = await buildWorkerOsImport([{ id: "x", name: "label", token: TOKEN_A, active: true }], {
			resolveIdentity: async () => ({ email: "real@example.com", accountId: "uuid-1", orgId: "org-1" }),
		});
		const credential = plan.data.credentials[0].credential as OAuthCredential;
		expect([credential.email, credential.accountId, credential.orgId]).toEqual([
			"real@example.com",
			"uuid-1",
			"org-1",
		]);
	});
});
