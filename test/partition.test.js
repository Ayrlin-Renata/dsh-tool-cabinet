import { test } from "node:test";
import assert from "node:assert/strict";
import { partition, drawerMatches, visibleNames, CABINET_TOOLS } from "../lib/partition.js";

/** Minimal schema stubs for partition fixtures. */
const tool = (name) => ({ name, description: `${name} tool`, parameters: {} });

const CONFIG = {
	enabled: true,
	applyToScopes: "all",
	desk: ["web_search"],
	unfiled: "visible",
	drawers: [
		{ id: "browser", label: "Browser", description: "web driving", match: { names: [], prefixes: ["browser_"], tags: [] } },
		{ id: "files", label: "Files", description: "file work", match: { names: ["pwsh"], prefixes: ["read", "write", "edit"], tags: ["fs"] } }
	],
	tags: { web_search: ["web"], web_fetch: ["web"] }
};

test("desk tools and cabinet tools are always visible", () => {
	const schemas = [tool("cabinet_list"), tool("cabinet_show"), tool("web_search"), tool("browser_click")];
	const { visible, desk } = partition(schemas, CONFIG);
	// browser_click is claimed by the browser drawer, so it is hidden from the wire;
	// desk + cabinet tools pass through.
	assert.deepEqual(visible.map((s) => s.name).sort(), ["cabinet_list", "cabinet_show", "web_search"]);
	assert.deepEqual(desk.map((s) => s.name).sort(), ["cabinet_list", "cabinet_show", "web_search"]);
});

test("prefix matching claims drawer tools; first drawer wins", () => {
	const schemas = [tool("browser_click"), tool("browser_open"), tool("read_page"), tool("write_file")];
	const { drawers, hidden } = partition(schemas, CONFIG);
	assert.deepEqual(drawers[0].tools.map((s) => s.name), ["browser_click", "browser_open"]);
	assert.deepEqual(drawers[1].tools.map((s) => s.name), ["read_page", "write_file"]);
	assert.equal(hidden.length, 4);
});

test("exact name and tag matching work; precedence names > prefixes > tags", () => {
	assert.equal(drawerMatches(tool("pwsh"), CONFIG.drawers[1], CONFIG), true);
	assert.equal(drawerMatches(tool("web_fetch"), CONFIG.drawers[1], CONFIG), false); // tag "web" belongs to no drawer match
	assert.equal(drawerMatches(tool("reading"), CONFIG.drawers[1], CONFIG), true); // prefix "read"
});

test("unfiled visible keeps unmatched tools on the wire; drawer withholds them", () => {
	const schemas = [tool("mystery_tool")];
	const visible = partition(schemas, CONFIG);
	assert.deepEqual(visible.visible.map((s) => s.name), ["mystery_tool"]);
	assert.deepEqual(visible.unfiled.map((s) => s.name), ["mystery_tool"]);

	const hidden = partition(schemas, { ...CONFIG, unfiled: "drawer" });
	assert.deepEqual(hidden.visible.map((s) => s.name), []);
	assert.deepEqual(hidden.unfiled.map((s) => s.name), ["mystery_tool"]);
});

test("desk beats a drawer that would also match", () => {
	const schemas = [tool("web_search")];
	// web_search has tag "web"; no drawer matches it, but even if one did, desk wins.
	const { desk, drawers } = partition(schemas, CONFIG);
	assert.deepEqual(desk.map((s) => s.name), ["web_search"]);
	assert.ok(drawers.every((drawer) => drawer.tools.length === 0));
});

test("visibleNames reports the wire set", () => {
	const schemas = [tool("cabinet_list"), tool("web_search"), tool("browser_click"), tool("stray")];
	assert.deepEqual([...visibleNames(schemas, CONFIG)].sort(), ["cabinet_list", "stray", "web_search"]);
});

test("CABINET_TOOLS names are stable", () => {
	assert.deepEqual(CABINET_TOOLS, ["cabinet_list", "cabinet_search", "cabinet_show", "cabinet_config"]);
});
