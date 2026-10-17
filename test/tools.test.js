import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { registerCabinetTools } from "../lib/tools.js";
import { normalizeConfig, writeConfigFile } from "../lib/config.js";

/**
 * Drive every cabinet tool through its real defineTool execution path and
 * validate each result with the harness's own validateJsonSchemaValue — the
 * same validator the runtime uses, which is what caught the wireDiff bug
 * (a `required: true` inside DIFF_SCHEMA made wireDiff mandatory on every
 * cabinet_config response, breaking action "get").
 */

const FIXTURE_SCHEMAS = [
	{ name: "cabinet_list", description: "cabinet tool", parameters: {} },
	{ name: "cabinet_search", description: "cabinet tool", parameters: {} },
	{ name: "cabinet_show", description: "cabinet tool", parameters: {} },
	{ name: "cabinet_config", description: "cabinet tool", parameters: {} },
	{ name: "web_search", description: "search the web", parameters: { query: { type: "string" } } },
	{ name: "web_fetch", description: "fetch a URL", parameters: {} },
	{ name: "browser_click", description: "click an element", parameters: {} },
	{ name: "stray_tool", description: "matches no drawer", parameters: {} }
];

const CONFIG = {
	enabled: true,
	applyToScopes: "all",
	desk: ["web_search"],
	unfiled: "visible",
	drawers: [
		{ id: "web", label: "Web", description: "web work", match: { names: [], prefixes: ["web_"], tags: [] } },
		{ id: "browser", label: "Browser", description: "browser work", match: { names: ["browser_click"], prefixes: [], tags: [] } }
	],
	tags: {}
};

/** Registry stub capturing defineTool results by name. */
function makeRegistry() {
	const registered = new Map();
	const ctx = {
		tools: {
			register(tool) {
				registered.set(tool.name, tool);
			},
			schemas() {
				return FIXTURE_SCHEMAS;
			}
		}
	};
	return { ctx, registered };
}

let tmpDir;
let store;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-tools-"));
	const filePath = path.join(tmpDir, "tool-cabinet.json");
	writeConfigFile(filePath, normalizeConfig(CONFIG));
	const current = { ...CONFIG };
	store = {
		get config() {
			return current;
		},
		path: filePath,
		error: null,
		reload() {
			const reloaded = JSON.parse(fs.readFileSync(filePath, "utf8"));
			Object.keys(current).forEach((key) => delete current[key]);
			Object.assign(current, reloaded);
		}
	};
});

/** Execute a registered tool and assert the result validates against its declared output schema. */
async function executeValid(registered, name, args, exec = { agent: undefined }) {
	const tool = registered.get(name);
	assert.ok(tool, `tool ${name} was registered`);
	const result = await tool.execute(args, exec);
	const violations = validateJsonSchemaValue(tool.output.schema, result, "");
	assert.deepEqual(violations, [], `${name} output violations: ${violations.join("; ")}`);
	return result;
}

test("cabinet_list overview and per-drawer output validate", async () => {
	const { ctx, registered } = makeRegistry();
	registerCabinetTools(ctx, { store });

	const overview = await executeValid(registered, "cabinet_list", {});
	assert.equal(overview.totalTools, FIXTURE_SCHEMAS.length);
	assert.deepEqual(overview.unfiled, ["stray_tool"]);

	const drawer = await executeValid(registered, "cabinet_list", { drawer: "web" });
	// web_search is on the desk and desk beats drawer, so only web_fetch lands here.
	assert.deepEqual(drawer.tools.map((tool) => tool.name), ["web_fetch"]);

	await assert.rejects(() => executeValid(registered, "cabinet_list", { drawer: "nope" }), /unknown drawer/);
});

test("cabinet_search output validates and matches by keyword", async () => {
	const { ctx, registered } = makeRegistry();
	registerCabinetTools(ctx, { store });

	const result = await executeValid(registered, "cabinet_search", { query: "web search", limit: 5 });
	assert.ok(result.matches.length >= 1);
	assert.equal(typeof result.matches[0].parameters, "object");

	// Empty query must throw before any output validation runs.
	await assert.rejects(() => executeValid(registered, "cabinet_search", { query: "   " }), /non-empty/);
});

test("cabinet_show output validates for a known tool and rejects unknown", async () => {
	const { ctx, registered } = makeRegistry();
	registerCabinetTools(ctx, { store });

	const result = await executeValid(registered, "cabinet_show", { name: "browser_click" });
	assert.equal(result.placement, "drawer:browser");

	await assert.rejects(() => executeValid(registered, "cabinet_show", { name: "missing" }), /no tool named/);
});

test("cabinet_config get validates WITHOUT wireDiff (the regression)", async () => {
	const { ctx, registered } = makeRegistry();
	registerCabinetTools(ctx, { store });

	const result = await executeValid(registered, "cabinet_config", { action: "get" });
	assert.equal(result.action, "get");
	assert.equal(result.applied, undefined);
	assert.equal(result.wireDiff, undefined);
	assert.equal(result.path, store.path);
});

test("cabinet_config preview computes a wire diff without writing", async () => {
	const { ctx, registered } = makeRegistry();
	registerCabinetTools(ctx, { store });
	const before = fs.readFileSync(store.path, "utf8");

	const result = await executeValid(registered, "cabinet_config", {
		action: "preview",
		patch: { desk: ["browser_click"], unfiled: "drawer" }
	});
	assert.equal(result.applied, undefined);
	// browser_click leaves the browser drawer for the desk (appears on the wire),
	// and stray_tool stops being pass-through (leaves the wire).
	assert.ok(result.wireDiff.addedToWire.includes("browser_click"));
	assert.ok(result.wireDiff.removedFromWire.includes("stray_tool"));
	assert.equal(fs.readFileSync(store.path, "utf8"), before, "preview must not write");
});

test("cabinet_config set writes atomically and swaps store config", async () => {
	const { ctx, registered } = makeRegistry();
	registerCabinetTools(ctx, { store });

	const result = await executeValid(registered, "cabinet_config", {
		action: "set",
		patch: { enabled: false }
	});
	assert.equal(result.applied, true);
	assert.equal(store.config.enabled, false, "store must reflect the swap after set");
	assert.equal(JSON.parse(fs.readFileSync(store.path, "utf8")).enabled, false);
	// No temp-file residue from the atomic write.
	assert.deepEqual(fs.readdirSync(tmpDir), ["tool-cabinet.json"]);
});

test("cabinet_config rejects invalid patches with a validated error object", async () => {
	const { ctx, registered } = makeRegistry();
	registerCabinetTools(ctx, { store });

	const result = await executeValid(registered, "cabinet_config", {
		action: "set",
		patch: { enabled: "nope" }
	});
	assert.match(result.error, /"enabled"/);
	assert.equal(result.applied, undefined);
});

test("cabinet_config without a patch for preview/set throws", async () => {
	const { ctx, registered } = makeRegistry();
	registerCabinetTools(ctx, { store });

	await assert.rejects(() => executeValid(registered, "cabinet_config", { action: "preview" }), /requires a "patch"/);
});

test("cabinet_config accepts a JSON-encoded string patch (provider stringification)", async () => {
	const { ctx, registered } = makeRegistry();
	registerCabinetTools(ctx, { store });
	const before = fs.readFileSync(store.path, "utf8");

	// Some provider bridges stringify nested object args — the model sends an
	// object but the tool receives a JSON string. This is what failed 5x in the
	// real session before the agent gave up and wrote the file by hand.
	const result = await executeValid(registered, "cabinet_config", {
		action: "preview",
		patch: JSON.stringify({ desk: ["browser_click"], unfiled: "drawer" })
	});
	assert.equal(result.action, "preview");
	assert.ok(result.wireDiff.addedToWire.includes("browser_click"));
	assert.ok(result.wireDiff.removedFromWire.includes("stray_tool"));
	assert.equal(fs.readFileSync(store.path, "utf8"), before, "preview must not write");

	// A string that is not valid JSON must throw with a helpful message.
	await assert.rejects(
		() => executeValid(registered, "cabinet_config", { action: "preview", patch: "{not json" }),
		/not valid JSON/
	);
});

test("cabinet_list shows the guide on the first call of a session, then only on help:true", async () => {
	const { ctx, registered } = makeRegistry();
	registerCabinetTools(ctx, { store });
	const agent = { id: "session-1" };
	const exec = { agent };

	// First call for this agent: guide present alongside the overview.
	const first = await executeValid(registered, "cabinet_list", {}, exec);
	assert.ok(typeof first.guide === "string" && first.guide.length > 0, "first call returns the guide");
	assert.equal(first.totalTools, FIXTURE_SCHEMAS.length);

	// Second call: guide suppressed.
	const second = await executeValid(registered, "cabinet_list", {}, exec);
	assert.equal(second.guide, undefined, "second call omits the guide");

	// help:true brings it back on demand.
	const forced = await executeValid(registered, "cabinet_list", { help: true }, exec);
	assert.ok(typeof forced.guide === "string" && forced.guide.length > 0, "help:true restores the guide");

	// A drawer listing carries the guide too when asked.
	const drawerForced = await executeValid(registered, "cabinet_list", { drawer: "web", help: true }, exec);
	assert.ok(typeof drawerForced.guide === "string", "help:true works with a drawer listing");

	// help:false on a first call suppresses it and stays suppressed.
	const agent2 = { id: "session-2" };
	const declined = await executeValid(registered, "cabinet_list", { help: false }, { agent: agent2 });
	assert.equal(declined.guide, undefined, "help:false hides the guide even on a first call");
	const declinedLater = await executeValid(registered, "cabinet_list", {}, { agent: agent2 });
	assert.equal(declinedLater.guide, undefined, "declining on the first call counts as seen");

	// A different agent (subagent scope) gets its own first-call guide.
	const agent3 = { id: "session-3" };
	const otherScope = await executeValid(registered, "cabinet_list", {}, { agent: agent3 });
	assert.ok(typeof otherScope.guide === "string", "each agent scope sees its own first-call guide");
});
