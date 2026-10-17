import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeConfig, loadConfigFile, writeConfigFile, openConfigStore, CabinetConfigError, DEFAULT_CONFIG } from "../lib/config.js";

test("normalizeConfig defaults are inert and safe", () => {
	const config = normalizeConfig({});
	assert.equal(config.enabled, false);
	assert.equal(config.applyToScopes, "all");
	assert.equal(config.unfiled, "visible");
	assert.deepEqual(config.drawers, []);
});

test("normalizeConfig rejects structural problems with every message", () => {
	assert.throws(() => normalizeConfig([]), CabinetConfigError);
	assert.throws(
		() => normalizeConfig({ enabled: "yes", unfiled: "maybe", drawers: [{ id: "Bad Id", label: "" }] }),
		(error) => error instanceof CabinetConfigError
			&& error.message.includes('"enabled"')
			&& error.message.includes('"unfiled"')
			&& error.message.includes("drawers[0].id")
			&& error.message.includes("drawers[0].label")
	);
});

test("normalizeConfig rejects duplicate drawer ids and unknown keys", () => {
	assert.throws(() => normalizeConfig({ drawers: [
		{ id: "a", label: "A" },
		{ id: "a", label: "B" }
	] }), /duplicated/);
	assert.throws(() => normalizeConfig({ deskTools: [] }), /unknown key "deskTools"/);
});

test("normalizeConfig accepts a full valid document and copies it", () => {
	const raw = {
		enabled: true,
		applyToScopes: ["main", "sub-1"],
		desk: ["web_search"],
		unfiled: "drawer",
		drawers: [{ id: "web", label: "Web", description: "fetching", match: { prefixes: ["web_"], tags: ["net"] } }],
		tags: { web_search: ["net"] }
	};
	const config = normalizeConfig(raw);
	assert.equal(config.enabled, true);
	assert.deepEqual(config.applyToScopes, ["main", "sub-1"]);
	assert.equal(config.drawers[0].match.prefixes[0], "web_");
	// Copies, not references: mutating the input later must not leak in.
	raw.desk.push("mutated");
	assert.deepEqual(config.desk, ["web_search"]);
});

test("loadConfigFile: missing file yields inert default; bad JSON throws", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-"));
	try {
		const missing = path.join(dir, "nope.json");
		assert.equal(loadConfigFile(missing).enabled, false);
		const bad = path.join(dir, "bad.json");
		fs.writeFileSync(bad, "{ not json", "utf8");
		assert.throws(() => loadConfigFile(bad), CabinetConfigError);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("writeConfigFile round-trips through loadConfigFile atomically", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-"));
	try {
		const file = path.join(dir, "nested", "tool-cabinet.json");
		const config = normalizeConfig({ enabled: true, drawers: [{ id: "a", label: "A" }] });
		writeConfigFile(file, config);
		assert.deepEqual(loadConfigFile(file), config);
		// No temp residue.
		assert.deepEqual(fs.readdirSync(path.dirname(file)), ["tool-cabinet.json"]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("openConfigStore keeps last-good config on invalid edits and reports errors", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-"));
	const warnings = [];
	const file = path.join(dir, "tool-cabinet.json");
	try {
		writeConfigFile(file, normalizeConfig({ enabled: true }));
		const store = openConfigFileForTest(file, warnings);
		assert.equal(store.config.enabled, true);

		// Invalid on-disk edit: last-good survives, error surfaces.
		fs.writeFileSync(file, '{"enabled": "nope"}', "utf8");
		store.reload();
		assert.equal(store.config.enabled, true);
		assert.match(store.error, /"enabled"/);
		assert.equal(warnings.length, 1);

		// Valid edit applies and clears the error.
		fs.writeFileSync(file, '{"enabled": false}', "utf8");
		store.reload();
		assert.equal(store.config.enabled, false);
		assert.equal(store.error, null);

		store.dispose();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("openConfigStore on a missing file starts inert without creating it", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-"));
	try {
		const file = path.join(dir, "tool-cabinet.json");
		const store = openConfigStore(file, {});
		assert.equal(store.config.enabled, false);
		assert.equal(fs.existsSync(file), false);
		store.dispose();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("DEFAULT_CONFIG is the inert shape", () => {
	assert.equal(DEFAULT_CONFIG.enabled, false);
	assert.deepEqual(DEFAULT_CONFIG.desk, []);
});

/** openConfigStore without fs.watch flakiness in tests: pass a stub logger. */
function openConfigFileForTest(file, warnings) {
	return openConfigStore(file, { logger: { warn: (message) => warnings.push(message) }, debounceMs: 5 });
}
