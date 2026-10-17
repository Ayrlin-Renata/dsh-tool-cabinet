/**
 * Pure partition logic: split the scope's registered tool schemas into the
 * desk (presented directly) and the drawers (kept out of the wire schemas).
 *
 * No imports by design — this module is testable with plain `node --test`
 * and free of any harness dependency.
 *
 * @module dsh-tool-cabinet/partition
 */

/**
 * The cabinet's own tools. They are always on the desk: an agent that cannot
 * reach the cabinet tools cannot open any drawer, so they are self-exempt
 * regardless of configuration.
 */
export const CABINET_TOOLS = Object.freeze([
	"cabinet_list",
	"cabinet_search",
	"cabinet_show",
	"cabinet_config"
]);

/**
 * Tags configured for one tool (config `tags` map). The registry's wire
 * ToolSchema is only `{ name, description, parameters }` — it carries no
 * plugin attribution — so plugin-style grouping is done through this
 * config-authored tag map instead of reading it off the schema.
 * @param {object} config - validated cabinet config.
 * @param {string} name - tool name.
 * @returns {string[]} the tool's configured tags (possibly empty).
 */
function toolTags(config, name) {
	return config.tags[name] ?? [];
}

/**
 * Whether one tool schema is claimed by one drawer. Precedence inside a
 * drawer: exact names, then name prefixes, then tags.
 * @param {{name: string}} schema - the candidate tool schema.
 * @param {object} drawer - a validated drawer entry.
 * @param {object} config - the full validated config (for the tag map).
 * @returns {boolean} true when the drawer claims the tool.
 */
export function drawerMatches(schema, drawer, config) {
	const match = drawer.match ?? {};
	if ((match.names ?? []).includes(schema.name)) return true;
	if ((match.prefixes ?? []).some((prefix) => schema.name.startsWith(prefix))) return true;
	const tags = toolTags(config, schema.name);
	if ((match.tags ?? []).some((tag) => tags.includes(tag))) return true;
	return false;
}

/**
 * Partition a scope's visible tool schemas into desk + drawers + unfiled.
 *
 * Claim order: desk (and the cabinet's own tools) first, then drawers in
 * config order — the first matching drawer claims a tool. Whatever no drawer
 * claims is unfiled: passed through as visible under `unfiled: "visible"`
 * (the fail-safe default: a brand-new tool is never silently hidden), or
 * withheld under `unfiled: "drawer"`.
 *
 * @param {readonly object[]} schemas - the scope's registered tool schemas.
 * @param {object} config - validated cabinet config.
 * @returns {{visible: object[], hidden: object[], desk: object[], drawers: Array<object & {tools: object[]}>, unfiled: object[]}}
 *   visible = wire schemas to keep; hidden = schemas withheld from the wire;
 *   drawers entries carry their claimed tool schemas.
 */
export function partition(schemas, config) {
	const visible = [];
	const desk = [];
	const claimed = new Set();
	const byDrawer = new Map(config.drawers.map((drawer) => [drawer.id, []]));

	for (const schema of schemas) {
		if (CABINET_TOOLS.includes(schema.name) || config.desk.includes(schema.name)) {
			visible.push(schema);
			desk.push(schema);
			claimed.add(schema.name);
		}
	}
	for (const drawer of config.drawers) {
		for (const schema of schemas) {
			if (claimed.has(schema.name)) continue;
			if (drawerMatches(schema, drawer, config)) {
				byDrawer.get(drawer.id).push(schema);
				claimed.add(schema.name);
			}
		}
	}
	const unfiled = [];
	for (const schema of schemas) {
		if (claimed.has(schema.name)) continue;
		unfiled.push(schema);
		if (config.unfiled === "visible") visible.push(schema);
	}

	const drawers = config.drawers.map((drawer) => ({ ...drawer, tools: byDrawer.get(drawer.id) }));
	const hidden = drawers.flatMap((drawer) => drawer.tools);
	if (config.unfiled === "drawer") hidden.push(...unfiled);
	return { visible, hidden, desk, drawers, unfiled };
}

/**
 * Names of the tools directly visible on the wire under a config.
 * @param {readonly object[]} schemas - candidate tool schemas.
 * @param {object} config - validated cabinet config.
 * @returns {Set<string>} the visible tool names.
 */
export function visibleNames(schemas, config) {
	return new Set(partition(schemas, config).visible.map((schema) => schema.name));
}
