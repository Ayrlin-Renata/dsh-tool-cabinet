/**
 * The four model-facing cabinet tools: browse drawers, search every tool,
 * inspect one tool's full schema, and manage the hot config.
 *
 * Soft compartmentalization only: these tools read the live registry through
 * `ctx.tools.schemas(agent)` (which is never filtered) and the wire filtering
 * happens solely in the assemble waterfall, so a discovered tool is callable
 * by exact name in the same turn even though its schema is not loaded.
 *
 * @module dsh-tool-cabinet/tools
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { partition, visibleNames } from "./partition.js";
import { normalizeConfig, writeConfigFile } from "./config.js";

/** Default/max match counts for cabinet_search. */
const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 50;

/**
 * Placement label of one tool under a config: "desk", "drawer:<id>", or
 * "unfiled".
 * @param {string} name - tool name.
 * @param {object} config - validated cabinet config.
 * @returns {string} the placement label.
 */
function placementOf(name, config) {
	if (config.desk.includes(name)) return "desk";
	for (const drawer of config.drawers) {
		const match = drawer.match ?? {};
		if ((match.names ?? []).includes(name)) return `drawer:${drawer.id}`;
		if ((match.prefixes ?? []).some((prefix) => name.startsWith(prefix))) return `drawer:${drawer.id}`;
		if ((match.tags ?? []).some((tag) => (config.tags[name] ?? []).includes(tag))) return `drawer:${drawer.id}`;
	}
	return "unfiled";
}

/**
 * Score one tool against a tokenized query. Whole-name and name-prefix hits
 * outweigh description hits, which outweigh drawer-label hits; every token
 * must contribute at least one hit or the tool is not a match.
 * @param {{name: string, description: string}} schema - candidate tool.
 * @param {string[]} tokens - lowercased query tokens.
 * @param {string} query - the original (lowercased) full query.
 * @param {object} config - validated cabinet config.
 * @returns {number} the score, or -1 when the tool misses.
 */
function scoreTool(schema, tokens, query, config) {
	const name = schema.name.toLowerCase();
	const description = (schema.description ?? "").toLowerCase();
	let score = 0;
	if (name === query) score += 50;
	else if (name.startsWith(query)) score += 30;
	for (const token of tokens) {
		let tokenScore = 0;
		if (name === token) tokenScore += 25;
		else if (name.includes(token)) tokenScore += 12;
		if (description.includes(token)) tokenScore += 5;
		for (const drawer of config.drawers) {
			if (drawer.label.toLowerCase().includes(token) || drawer.description.toLowerCase().includes(token)) tokenScore += 3;
		}
		if (tokenScore === 0) return -1;
		score += tokenScore;
	}
	return score;
}

/** Schemas kept out of the wire under a config, for drawer-scoped listings. */
function drawerTools(schemas, drawerId, config) {
	const parts = partition(schemas, config);
	if (drawerId === "unfiled") return parts.unfiled;
	const drawer = parts.drawers.find((entry) => entry.id === drawerId);
	return drawer?.tools ?? null;
}

/** Shared JSON-schema-subset pieces for the tool outputs. */
const STRING_ARRAY = { type: "array", items: { type: "string" } };
const OPEN_OBJECT = { type: "object", additionalProperties: true };
const DIFF_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		addedToWire: { ...STRING_ARRAY, required: true, description: "Tools that would become directly visible." },
		removedFromWire: { ...STRING_ARRAY, required: true, description: "Tools that would move into drawers." }
	}
};

/**
 * Register the cabinet tools on `ctx.tools`. They close over the live config
 * store, so every call reflects the latest hot-config state.
 * @param {object} ctx - registrant context carrying the tool registry.
 * @param {{store: import("./config.js").CabinetStore, logger: object}} deps - live dependencies.
 */
export function registerCabinetTools(ctx, { store }) {
	const schemasFor = (exec) => ctx.tools.schemas(exec.agent);

	ctx.tools.register(defineTool({
		name: "cabinet_list",
		description: "List the tool cabinet: the drawers (labeled capability groups) with the tools inside each, the desk tools that are always directly available, and totals. Use this to see what tool sets exist and how many tools this harness has. Tools inside drawers are NOT in your loaded schemas but ARE still callable by exact name — use cabinet_search or cabinet_show first to get a tool's full parameter schema, then call it.",
		parameters: {
			drawer: {
				type: "string",
				description: "Optional drawer id (or \"unfiled\") to list just that drawer's tools with descriptions. Omit for the overview."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					totalTools: { type: "integer", required: true, description: "Tools visible to your scope in total." },
					desk: { ...STRING_ARRAY, required: true, description: "Always-shown tools (yours and the configured desk)." },
					drawers: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string", required: true },
								label: { type: "string", required: true },
								description: { type: "string", required: true },
								tools: { ...STRING_ARRAY, required: true }
							}
						}
					},
					unfiled: { ...STRING_ARRAY, required: true, description: "Tools matched by no drawer." },
					tools: {
						type: "array",
						description: "Present only when a drawer was requested: that drawer's tools with descriptions.",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string", required: true },
								description: { type: "string", required: true }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				if (value.tools !== undefined) {
					const lines = value.tools.map((tool) => `- ${tool.name}: ${tool.description}`);
					return [{ type: "text", text: `${value.tools.length} tool(s) in this drawer:\n${lines.join("\n")}` }];
				}
				const lines = [
					`Total tools in your scope: ${value.totalTools}`,
					`Desk (always available): ${value.desk.join(", ") || "(none)"}`
				];
				for (const drawer of value.drawers) lines.push(`${drawer.id} — ${drawer.label}: ${drawer.tools.join(", ") || "(empty)"}`);
				if (value.unfiled.length > 0) lines.push(`unfiled (matched no drawer): ${value.unfiled.join(", ")}`);
				return [{ type: "text", text: lines.join("\n") }];
			}
		},
		execute(args, exec) {
			const config = store.config;
			const schemas = schemasFor(exec);
			const parts = partition(schemas, config);
			if (args.drawer !== undefined) {
				const tools = drawerTools(schemas, args.drawer, config);
				if (tools === null) throw new Error(`unknown drawer "${args.drawer}"; use cabinet_list without arguments to see drawer ids`);
				return Promise.resolve({
					totalTools: schemas.length,
					desk: parts.desk.map((schema) => schema.name),
					drawers: [],
					unfiled: [],
					tools: tools.map((schema) => ({ name: schema.name, description: schema.description }))
				});
			}
			return Promise.resolve({
				totalTools: schemas.length,
				desk: parts.desk.map((schema) => schema.name),
				drawers: parts.drawers.map((drawer) => ({
					id: drawer.id,
					label: drawer.label,
					description: drawer.description,
					tools: drawer.tools.map((schema) => schema.name)
				})),
				unfiled: parts.unfiled.map((schema) => schema.name)
			});
		}
	}));

	ctx.tools.register(defineTool({
		name: "cabinet_search",
		description: "Search every tool on this harness (desk and drawers) by keyword. Matches tool names, descriptions, and drawer labels; every query word must match somewhere. Each match includes the tool's FULL parameter schema, so you can call a matched tool in this same turn without loading it into your schemas.",
		parameters: {
			query: { type: "string", required: true, description: "Keywords to search for, e.g. \"browser screenshot\" or \"session history\"." },
			limit: { type: "integer", description: `Maximum matches to return (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}).` }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					query: { type: "string", required: true },
					count: { type: "integer", required: true },
					matches: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string", required: true },
								description: { type: "string", required: true },
								placement: { type: "string", required: true, description: "desk, drawer:<id>, or unfiled." },
								parameters: { ...OPEN_OBJECT, required: true, description: "The tool's full JSON Schema for its arguments." }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				if (value.count === 0) return [{ type: "text", text: `No tools matched "${value.query}". Try cabinet_list to browse drawers, or a shorter query.` }];
				const lines = value.matches.map((match) => `- ${match.name} [${match.placement}]: ${match.description}`);
				return [{ type: "text", text: `${value.count} match(es) for "${value.query}" (parameters included in each match — call any of them by exact name):\n${lines.join("\n")}` }];
			}
		},
		execute(args, exec) {
			const config = store.config;
			const query = args.query.trim().toLowerCase();
			if (query === "") throw new Error("query must be non-empty");
			const tokens = query.split(/\s+/).filter((token) => token.length > 0);
			const limit = Math.min(Math.max(args.limit ?? SEARCH_DEFAULT_LIMIT, 1), SEARCH_MAX_LIMIT);
			const matches = [];
			for (const schema of schemasFor(exec)) {
				const score = scoreTool(schema, tokens, query, config);
				if (score < 0) continue;
				matches.push({
					name: schema.name,
					description: schema.description,
					placement: placementOf(schema.name, config),
					parameters: schema.parameters,
					score
				});
			}
			matches.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
			const top = matches.slice(0, limit).map(({ score: _score, ...match }) => match);
			return Promise.resolve({ query: args.query, count: top.length, matches: top });
		}
	}));

	ctx.tools.register(defineTool({
		name: "cabinet_show",
		description: "Show one tool's complete definition: description, full parameter schema, and where it lives (desk, a drawer id, or unfiled). Use this when you already know a tool's exact name and need its schema before calling it.",
		parameters: {
			name: { type: "string", required: true, description: "The exact tool name." }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					name: { type: "string", required: true },
					description: { type: "string", required: true },
					placement: { type: "string", required: true },
					parameters: { ...OPEN_OBJECT, required: true }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `${value.name} [${value.placement}]: ${value.description}\nParameters: ${JSON.stringify(value.parameters)}`
			}]
		},
		execute(args, exec) {
			const schema = schemasFor(exec).find((entry) => entry.name === args.name);
			if (schema === undefined) {
				throw new Error(`no tool named "${args.name}" in this scope; use cabinet_search to find it`);
			}
			return Promise.resolve({
				name: schema.name,
				description: schema.description,
				placement: placementOf(schema.name, store.config),
				parameters: schema.parameters
			});
		}
	}));

	ctx.tools.register(defineTool({
		name: "cabinet_config",
		description: "Read or change the tool cabinet configuration (hot-applied, no restart). Actions: \"get\" returns the current config and file path; \"preview\" validates a patch and reports which tools would appear on or leave the wire WITHOUT writing; \"set\" validates a patch, writes the config file atomically, and applies it immediately. A patch is a partial config object whose top-level keys replace the current ones (e.g. {\"desk\": [\"web_search\"]}); omitted keys stay unchanged. Drawers claim tools in order by exact name, then name prefix, then tag (from the config tags map).",
		parameters: {
			action: { type: "string", required: true, enum: ["get", "preview", "set"], description: "get | preview | set." },
			patch: { type: "json", description: "Partial config object for preview/set. Ignored for get." }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					action: { type: "string", required: true },
					path: { type: "string", required: true, description: "Absolute path of the hot config file." },
					applied: { type: "boolean", description: "True only for a successful set." },
					lastError: { type: "string", description: "Last config-file validation error, when the file currently on disk is invalid." },
					config: { ...OPEN_OBJECT, description: "The current (get) or proposed (preview/set) config." },
					wireDiff: { ...DIFF_SCHEMA, description: "Preview/set: effect of the patch on the wire-visible tool set." },
					error: { type: "string", description: "Validation problem, when the patch was rejected." }
				}
			},
			render: (_args, value) => {
				if (value.error !== undefined) return [{ type: "text", text: `Patch rejected: ${value.error}` }];
				if (value.action === "get") {
					const head = `Cabinet config at ${value.path}:\n${JSON.stringify(value.config, null, 2)}`;
					return [{ type: "text", text: value.lastError === undefined ? head : `${head}\n(last file edit was invalid and ignored: ${value.lastError})` }];
				}
				const diff = value.wireDiff;
				const effect = diff.addedToWire.length === 0 && diff.removedFromWire.length === 0
					? "No change to the wire-visible tool set."
					: `On the wire: + [${diff.addedToWire.join(", ") || "none"}] / - [${diff.removedFromWire.join(", ") || "none"}]`;
				return [{ type: "text", text: `${value.applied === true ? "Applied" : "Preview"}; config file ${value.path}. ${effect}` }];
			}
		},
		execute(args, exec) {
			const base = { path: store.path, action: args.action };
			if (store.error !== null) base.lastError = store.error;
			if (args.action === "get") {
				return Promise.resolve({ ...base, config: store.config });
			}
			if (args.patch === undefined || args.patch === null || typeof args.patch !== "object" || Array.isArray(args.patch)) {
				throw new Error(`action "${args.action}" requires a "patch" object`);
			}
			let proposed;
			try {
				proposed = normalizeConfig({ ...store.config, ...args.patch });
			} catch (error) {
				return Promise.resolve({ ...base, error: error.message });
			}
			const schemas = schemasFor(exec);
			const before = visibleNames(schemas, store.config);
			const after = visibleNames(schemas, proposed);
			const wireDiff = {
				addedToWire: [...after].filter((name) => !before.has(name)).sort(),
				removedFromWire: [...before].filter((name) => !after.has(name)).sort()
			};
			if (args.action === "preview") {
				return Promise.resolve({ ...base, config: proposed, wireDiff });
			}
			writeConfigFile(store.path, proposed);
			store.reload();
			return Promise.resolve({ ...base, applied: true, config: proposed, wireDiff });
		}
	}));
}
