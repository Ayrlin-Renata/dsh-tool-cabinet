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
	{ name: "browser_click", description: "click an element", parameters: { selector: { type: "string" }, index: { type: "integer" } } },
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
function makeRegistry(schemas = FIXTURE_SCHEMAS) {
	const registered = new Map();
	const ctx = {
		tools: {
			register(tool) {
				registered.set(tool.name, tool);
			},
			schemas() {
				return schemas;
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
	assert.equal(result.count, 1);
	assert.equal(result.tools[0].placement, "drawer:browser");

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

test("cabinet_search renders each match's parameters in the delivered text", async () => {
	const { ctx, registered } = makeRegistry();
	registerCabinetTools(ctx, { store });

	// Regression: the output schema carried `parameters` but the render omitted
	// them, so the model never saw the schemas search claimed to include.
	const result = await executeValid(registered, "cabinet_search", { query: "web", limit: 5 });
	const text = registered.get("cabinet_search").output.render({ query: "web" }, result)[0].text;
	assert.match(text, /Parameters:/, "rendered search output must include the parameters payload");
});

test("cabinet_search scores a drawer-label hit only for tools inside that drawer", async () => {
	const { ctx, registered } = makeRegistry();
	registerCabinetTools(ctx, { store });

	// Regression: scoring checked every drawer's label for every tool, so one
	// label containing "browser" matched all 8 tools and the alphabetical
	// tie-break returned an arbitrary slice. Only browser_click lives in the
	// browser drawer, so only it may match on that label.
	const result = await executeValid(registered, "cabinet_search", { query: "browser" });
	assert.ok(result.matches.length > 0, "the browser drawer label still matches its own tool");
	for (const match of result.matches) {
		assert.equal(match.placement, "drawer:browser", `"${match.name}" matched the browser label but does not live in that drawer`);
	}
	assert.ok(result.matches.some((match) => match.name === "browser_click"), "browser_click must be found via its drawer label");
});

test("cabinet_list withSchemas returns full parameter schemas, drawer-scoped", async () => {
	const { ctx, registered } = makeRegistry();
	registerCabinetTools(ctx, { store });

	// browser_click is the drawer-resident tool (web_search is on the desk, and
	// desk beats drawer, so the web drawer would only hold empty-schema web_fetch).
	const withSchemas = await executeValid(registered, "cabinet_list", { drawer: "browser", withSchemas: true });
	assert.deepEqual(withSchemas.tools.map((tool) => tool.name), ["browser_click"]);
	assert.deepEqual(withSchemas.tools[0].parameters, { selector: { type: "string" }, index: { type: "integer" } }, "withSchemas must carry the full parameter schema");

	// The rendered text must surface those schemas too, not just descriptions.
	const text = registered.get("cabinet_list").output.render({ drawer: "browser", withSchemas: true }, withSchemas)[0].text;
	assert.match(text, /Parameters:/, "rendered drawer dump must include the schemas");

	// Default remains descriptions-only.
	const plain = await executeValid(registered, "cabinet_list", { drawer: "browser" });
	assert.equal(plain.tools[0].parameters, undefined, "without withSchemas the drawer listing stays description-only");

	// withSchemas without a drawer id is refused — whole-cabinet dumps are out.
	await assert.rejects(
		() => executeValid(registered, "cabinet_list", { withSchemas: true }),
		/requires a drawer id/
	);
});
/** A store whose config carries one compatibility alias. */
function aliasStore() {
	return {
		config: {
			enabled: true,
			applyToScopes: "all",
			desk: ["web_search"],
			unfiled: "visible",
			drawers: [...CONFIG.drawers],
			tags: {},
			aliases: { read_client: { target: "read", params: { file_path: "path" }, description: "" } }
		},
		path: "C:/tmp/tool-cabinet.json",
		error: null,
		reload() {}
	};
}

const ALIAS_SCHEMAS = [
	...FIXTURE_SCHEMAS,
	{
		name: "read_client",
		description: 'Compatibility alias for "read".',
		parameters: { type: "object", additionalProperties: true, properties: {} }
	}
];

test("aliases stay out of the inventory and out of search unless asked for", async () => {
	const { ctx, registered } = makeRegistry(ALIAS_SCHEMAS);
	registerCabinetTools(ctx, { store: aliasStore() });

	// Default view: the alias is invisible — not counted, not listed, not unfiled.
	const overview = await executeValid(registered, "cabinet_list", {});
	assert.equal(overview.totalTools, FIXTURE_SCHEMAS.length, "aliases are not counted as tools");
	assert.equal(overview.aliases, undefined, "aliases are not listed by default");
	assert.ok(!overview.unfiled.includes("read_client"), "an alias is never unfiled-visible");

	// includeAliases reveals them.
	const withAliases = await executeValid(registered, "cabinet_list", { includeAliases: true });
	assert.deepEqual(withAliases.aliases, [{ name: "read_client", target: "read", description: "" }]);
	assert.ok(withAliases.totalTools === FIXTURE_SCHEMAS.length, "revealing aliases does not inflate the tool count");

	// The alias cabinet is a reserved drawer id.
	const drawer = await executeValid(registered, "cabinet_list", { drawer: "aliases" });
	assert.deepEqual(drawer.tools.map((tool) => tool.name), ["read_client"]);

	// Search hides them by default and finds them on request.
	const hidden = await executeValid(registered, "cabinet_search", { query: "read" });
	assert.equal(hidden.count, 0, "search does not surface aliases by default");
	const shown = await executeValid(registered, "cabinet_search", { query: "read", includeAliases: true });
	assert.deepEqual(shown.matches.map((match) => match.name), ["read_client"]);

	// An exact-name lookup still reaches the alias (a deliberate by-name call).
	const direct = await executeValid(registered, "cabinet_show", { name: "read_client" });
	assert.equal(direct.tools[0].placement, "aliases");
});
test("cabinet_show accepts several names in one call", async () => {
	const { ctx, registered } = makeRegistry();
	registerCabinetTools(ctx, { store });

	const batch = await executeValid(registered, "cabinet_show", { names: ["web_fetch", "browser_click", "nope"] });
	assert.equal(batch.count, 2);
	assert.deepEqual(batch.tools.map((tool) => tool.name), ["web_fetch", "browser_click"]);
	assert.deepEqual(batch.missing, ["nope"]);

	const rendered = registered.get("cabinet_show").output.render({}, batch).map((block) => block.text).join("\n");
	assert.match(rendered, /2 tool definition\(s\)/);
	assert.match(rendered, /Not found in this scope: nope/);
	assert.match(rendered, /Parameters:/);

	// Duplicates collapse to one lookup.
	const deduped = await executeValid(registered, "cabinet_show", { names: ["web_fetch", "web_fetch"] });
	assert.equal(deduped.count, 1);

	// A single resolved name keeps the compact one-tool rendering (no batch head).
	const single = await executeValid(registered, "cabinet_show", { name: "web_fetch" });
	assert.equal(single.count, 1);
	const singleText = registered.get("cabinet_show").output.render({}, single).map((block) => block.text).join("\n");
	assert.doesNotMatch(singleText, /tool definition\(s\)/);

	await assert.rejects(() => executeValid(registered, "cabinet_show", { names: ["nope"] }), /no tool named/);
	await assert.rejects(() => executeValid(registered, "cabinet_show", { name: "web_fetch", names: ["web_fetch"] }), /not both/);
	await assert.rejects(() => executeValid(registered, "cabinet_show", {}), /requires "name"/);
	await assert.rejects(
		() => executeValid(registered, "cabinet_show", { names: Array.from({ length: 26 }, (_, index) => `t${index}`) }),
		/at most 25 names/
	);
});
