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
import { partition, visibleNames, aliasNames } from "./partition.js";
import { normalizeConfig, writeConfigFile, ALIAS_DRAWER_ID } from "./config.js";

/** Default/max match counts for cabinet_search. */
const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 50;
/** Max names accepted by one cabinet_show call (whole-cabinet dumps stay refused). */
const SHOW_MAX_NAMES = 25;

/**
 * Placement label of one tool under a config: "desk", "drawer:<id>", or
 * "unfiled".
 * @param {string} name - tool name.
 * @param {object} config - validated cabinet config.
 * @returns {string} the placement label.
 */
function placementOf(name, config) {
	if (Object.hasOwn(config.aliases ?? {}, name)) return ALIAS_DRAWER_ID;
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
	// A drawer label/description hit only counts for tools that actually live
	// in that drawer. Scoring every tool against every drawer's label would
	// give one label match to all N tools, so searching a drawer name returned
	// an alphabetical slice of the whole harness instead of that drawer's
	// contents.
	const placement = placementOf(schema.name, config);
	const ownDrawer = placement.startsWith("drawer:")
		? config.drawers.find((drawer) => `drawer:${drawer.id}` === placement)
		: undefined;
	for (const token of tokens) {
		let tokenScore = 0;
		if (name === token) tokenScore += 25;
		else if (name.includes(token)) tokenScore += 12;
		if (description.includes(token)) tokenScore += 5;
		if (ownDrawer !== undefined
			&& (ownDrawer.label.toLowerCase().includes(token) || ownDrawer.description.toLowerCase().includes(token))) {
			tokenScore += 3;
		}
		if (tokenScore === 0) return -1;
		score += tokenScore;
	}
	return score;
}

/** Schemas kept out of the wire under a config, for drawer-scoped listings. */
function drawerTools(schemas, drawerId, config) {
	// The alias cabinet is reserved and self-describing: it lists the hidden
	// adapters only when explicitly asked for by this drawer id.
	if (drawerId === ALIAS_DRAWER_ID) return schemas.filter((schema) => Object.hasOwn(config.aliases ?? {}, schema.name));
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
 * Shown on the first cabinet_list call of a session (or any call with
 * help:true). Explains the organization model, which is otherwise non-obvious.
 */
const HELP_TEXT = [
	"How the tool cabinet works:",
	"- Only the tools listed as DESK (plus the 4 cabinet_* tools) are in your loaded schemas. Everything else is filed into DRAWERS by capability.",
	"- A tool inside a drawer is STILL fully callable by exact name — nothing blocks you. But its parameters are not loaded, so before calling one you do not know its arguments.",
	"- To use drawer tools: cabinet_search {query} (keyword search over names, descriptions, drawer labels — returns every match's full schema in one call), cabinet_list {drawer: <id>, withSchemas: true} (a whole drawer's schemas in one call), or cabinet_show {name | names} (one tool or several, by exact name). All return FULL parameter schemas, so you can call those tools in the same turn — look up several at once rather than one at a time.",
	"- Match precedence when filing: exact name, then name prefix, then tag. Tools matching no drawer are \"unfiled\": they pass through (visible) or are withheld, per config.",
	"- The cabinet itself is hot-configured via cabinet_config (get/preview/set) — no restart needed. preview reports which tools would move on/off the wire before you commit.",
	"- This listing is a map, not a menu: it exists so you know what capability sets exist and how many tools there are, without every schema being injected each turn.",
	"- If cabinet_* tools ever return `unknown tool`, this plugin's fiber was torn down (typically by an HMR recompose of the patch config) and rebuilt fibers did not restore it. The config file on disk is intact, so no settings are lost — only a restart brings the tools back. Meanwhile two things confirm it: the cabinet_* tools are unknown to dispatch, and filtering stopped, so many more tools are visible than this guide described. Your other tools are unaffected."
].join("\n");

/**
 * Register the cabinet tools on `ctx.tools`. They close over the live config
 * store, so every call reflects the latest hot-config state.
 * @param {object} ctx - registrant context carrying the tool registry.
 * @param {{store: import("./config.js").CabinetStore, logger: object}} deps - live dependencies.
 */
export function registerCabinetTools(ctx, { store }) {
	const schemasFor = (exec) => ctx.tools.schemas(exec.agent);
	// Agents (sessions/scopes) whose first cabinet_list call already settled the
	// guide question. In-memory on purpose: after a restart the guide may
	// reappear, which is harmless (and useful if the model's context was compacted).
	const guidedAgents = new Set();
	const guideFor = (args, exec) => {
		const agentKey = exec.agent ?? null;
		const alreadyGuided = guidedAgents.has(agentKey);
		guidedAgents.add(agentKey);
		// help:true always shows; help:false always hides; omitted shows only on
		// the first call for this agent.
		return args.help === true || (args.help === undefined && !alreadyGuided) ? HELP_TEXT : undefined;
	};

	ctx.tools.register(defineTool({
		name: "cabinet_list",
		description: "List the tool cabinet: the drawers (labeled capability groups) with the tools inside each, the desk tools that are always directly available, and totals. Use this to see what tool sets exist and how many tools this harness has. Tools inside drawers are NOT in your loaded schemas but ARE still callable by exact name — pass withSchemas:true with a drawer id to get that drawer's full parameter schemas in one call, or use cabinet_search to list several tools' schemas in one call (or cabinet_show for a single tool), then call them. Your first call in a session also returns a short guide to how the cabinet works; pass help:true to see it again, or help:false to skip it.",
		parameters: {
			drawer: {
				type: "string",
				description: "Optional drawer id (or \"unfiled\") to list just that drawer's tools with descriptions. Omit for the overview."
			},
			help: {
				type: "boolean",
				description: "true: include the guide to how the cabinet works (normally shown automatically on the first call of a session). false: never include it."
			},
			includeAliases: {
				type: "boolean",
				description: "true: also list compatibility aliases (foreign tool names this harness answers to). Omitted/false: aliases stay hidden, as they are absent from the wire and from your loaded schemas."
			},
			withSchemas: {
				type: "boolean",
				description: "true: include each listed tool's full parameter schema. Requires a drawer id (a whole-cabinet dump would defeat the point of the cabinet), so pass it together with drawer. false: descriptions only."
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
					guide: {
						type: "string",
						description: "The how-the-cabinet-works guide. Present on the first cabinet_list call of a session, or whenever help:true was passed."
					},
					tools: {
						type: "array",
						description: "Present only when a drawer was requested: that drawer's tools with descriptions (and full parameter schemas when withSchemas:true).",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string", required: true },
								description: { type: "string", required: true },
								parameters: { ...OPEN_OBJECT, description: "The tool's full parameter schema. Present only when withSchemas:true." }
							}
						}
					},
					aliases: {
						type: "array",
						description: "Present only when includeAliases:true: the compatibility aliases configured for this harness.",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string", required: true },
								target: { type: "string", required: true, description: "The real tool this alias delegates to." },
								description: { type: "string", required: true }
							}
						}
					}
				}
			},
			render: (args, value) => {
				const guide = value.guide === undefined ? "" : `${value.guide}\n\n`;
				if (value.tools !== undefined) {
					const lines = value.tools.map((tool) => tool.parameters === undefined
						? `- ${tool.name}: ${tool.description}`
						: `- ${tool.name}: ${tool.description}\n    Parameters: ${JSON.stringify(tool.parameters)}`);
					if (args.drawer === ALIAS_DRAWER_ID) {
						const aliasHeading = value.tools.length === 1
							? "1 compatibility alias — a hidden adapter for a foreign tool name:"
							: `${value.tools.length} compatibility aliases — hidden adapters for foreign tool names:`;
						return [{ type: "text", text: `${guide}${aliasHeading}\n${lines.join("\n")}\n\nAn alias answers to a tool name that other harnesses use, so a call made out of habit succeeds. It is callable by exact name but is deliberately absent from your loaded schemas and from search results.` }];
					}
					const heading = value.tools.length === 1 ? "1 tool in this drawer:" : `${value.tools.length} tools in this drawer:`;
					return [{ type: "text", text: `${guide}${heading}\n${lines.join("\n")}` }];
				}
				const lines = [
					`Total tools in your scope: ${value.totalTools}`,
					`Desk (always shown): ${value.desk.join(", ") || "(none)"}`
				];
				for (const drawer of value.drawers) lines.push(`${drawer.id} — ${drawer.label}: ${drawer.tools.join(", ") || "(empty)"}`);
				if (value.unfiled.length > 0) lines.push(`unfiled (matched no drawer): ${value.unfiled.join(", ")}`);
				if (value.aliases !== undefined) {
					lines.push(value.aliases.length === 0
						? "aliases: (none configured)"
						: `aliases (compatibility names, callable but not on the wire): ${value.aliases.map((alias) => `${alias.name}->${alias.target}`).join(", ")}`);
				}
				return [{ type: "text", text: `${guide}${lines.join("\n")}` }];
			}
		},
		execute(args, exec) {
			const config = store.config;
			const allSchemas = schemasFor(exec);
			const aliasSet = aliasNames(config);
			// Aliases are never part of the inventory the cabinet reports: the
			// agent gets the real tool map and sees adapters only on request.
			const schemas = aliasSet.size === 0 ? allSchemas : allSchemas.filter((schema) => !aliasSet.has(schema.name));
			const parts = partition(schemas, config);
			const guide = guideFor(args, exec);
			// withSchemas is drawer-scoped on purpose: a whole-cabinet dump would
			// re-inject every schema the cabinet exists to keep off the wire.
			if (args.withSchemas === true && args.drawer === undefined) {
				throw new Error("withSchemas:true requires a drawer id (whole-cabinet schema dumps are not supported) — pass e.g. { drawer: \"browser\", withSchemas: true }");
			}
			if (args.drawer !== undefined) {
				const tools = drawerTools(allSchemas, args.drawer, config);
				if (tools === null) throw new Error(`unknown drawer "${args.drawer}"; use cabinet_list without arguments to see drawer ids`);
				return Promise.resolve({
					...(guide === undefined ? {} : { guide }),
					totalTools: schemas.length,
					desk: parts.desk.map((schema) => schema.name),
					drawers: [],
					unfiled: [],
					tools: tools.map((schema) => args.withSchemas === true
						? { name: schema.name, description: schema.description, parameters: schema.parameters }
						: { name: schema.name, description: schema.description })
				});
			}
			return Promise.resolve({
				...(guide === undefined ? {} : { guide }),
				totalTools: schemas.length,
				desk: parts.desk.map((schema) => schema.name),
				drawers: parts.drawers.map((drawer) => ({
					id: drawer.id,
					label: drawer.label,
					description: drawer.description,
					tools: drawer.tools.map((schema) => schema.name)
				})),
				unfiled: parts.unfiled.map((schema) => schema.name),
				...args.includeAliases === true
					? {
						aliases: Object.entries(config.aliases).map(([name, spec]) => ({
							name,
							target: spec.target,
							description: spec.description
						}))
					}
					: {}
			});
		}
	}));

	ctx.tools.register(defineTool({
		name: "cabinet_search",
		description: "Search every tool on this harness (desk and drawers) by keyword. Matches tool names, descriptions, and drawer labels; every query word must match somewhere. Each match includes the tool's FULL parameter schema, so you can call a matched tool in this same turn without loading it into your schemas.",
		parameters: {
			query: { type: "string", required: true, description: "Keywords to search for, e.g. \"browser screenshot\" or \"session history\"." },
			limit: { type: "integer", description: `Maximum matches to return (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}).` },
			includeAliases: {
				type: "boolean",
				description: "true: also search compatibility aliases (foreign tool names this harness answers to). Omitted/false: aliases are excluded."
			}
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
								placement: { type: "string", required: true, description: "desk, drawer:<id>, unfiled, or aliases." },
								parameters: { ...OPEN_OBJECT, required: true, description: "The tool's full JSON Schema for its arguments." }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				if (value.count === 0) return [{ type: "text", text: `No tools matched "${value.query}". Try cabinet_list to browse drawers, or a shorter query.` }];
				const lines = value.matches.map((match) => `- ${match.name} [${match.placement}]: ${match.description}\n    Parameters: ${JSON.stringify(match.parameters)}`);
				return [{ type: "text", text: `${value.count} match(es) for "${value.query}" — each match's parameters are below; call any of them by exact name:\n${lines.join("\n")}` }];
			}
		},
		execute(args, exec) {
			const config = store.config;
			const query = args.query.trim().toLowerCase();
			if (query === "") throw new Error("query must be non-empty");
			const tokens = query.split(/\s+/).filter((token) => token.length > 0);
			const limit = Math.min(Math.max(args.limit ?? SEARCH_DEFAULT_LIMIT, 1), SEARCH_MAX_LIMIT);
			const matches = [];
			// Aliases stay out of search results unless explicitly requested.
			const excludedAliases = args.includeAliases === true ? new Set() : aliasNames(config);
			for (const schema of schemasFor(exec)) {
				if (excludedAliases.has(schema.name)) continue;
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
		description: `Show complete definitions — description, full parameter schema, and placement (desk, a drawer id, unfiled, or aliases) — for one tool (name) or several at once (names, up to ${SHOW_MAX_NAMES}). Use it when you know the exact names; to discover tools by capability use cabinet_search, or cabinet_list {drawer, withSchemas: true} for a whole drawer.`,
		parameters: {
			name: { type: "string", description: "One tool's exact name. Use names to look up several at once." },
			names: { type: "array", items: { type: "string" }, description: `Several tools' exact names (max ${SHOW_MAX_NAMES}). Use name for a single tool.` }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					count: { type: "integer", required: true },
					tools: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string", required: true },
								description: { type: "string", required: true },
								placement: { type: "string", required: true },
								parameters: { ...OPEN_OBJECT, required: true }
							}
						}
					},
					missing: { ...STRING_ARRAY, description: "Requested names that resolved to no tool. Present only when some were not found." }
				}
			},
			render: (_args, value) => {
				const blocks = value.tools.map((tool) => `${tool.name} [${tool.placement}]: ${tool.description}\nParameters: ${JSON.stringify(tool.parameters)}`);
				const head = value.count === 1 && value.missing === undefined ? "" : `${value.count} tool definition(s):\n\n`;
				const tail = value.missing === undefined ? "" : `\n\nNot found in this scope: ${value.missing.join(", ")}`;
				return [{ type: "text", text: `${head}${blocks.join("\n\n")}${tail}` }];
			}
		},
		execute(args, exec) {
			if (args.name === undefined && args.names === undefined) {
				throw new Error('cabinet_show requires "name" (one tool) or "names" (several)');
			}
			if (args.name !== undefined && args.names !== undefined) {
				throw new Error('pass either "name" or "names", not both');
			}
			const unique = [...new Set(args.name !== undefined ? [args.name] : args.names)];
			if (unique.length > SHOW_MAX_NAMES) {
				throw new Error(`cabinet_show accepts at most ${SHOW_MAX_NAMES} names; for a whole drawer use cabinet_list {drawer, withSchemas: true}`);
			}
			const schemas = schemasFor(exec);
			const config = store.config;
			const tools = [];
			const missing = [];
			for (const toolName of unique) {
				const schema = schemas.find((entry) => entry.name === toolName);
				if (schema === undefined) {
					missing.push(toolName);
					continue;
				}
				tools.push({
					name: schema.name,
					description: schema.description,
					placement: placementOf(schema.name, config),
					parameters: schema.parameters
				});
			}
			if (tools.length === 0) {
				throw new Error(`no tool named ${missing.map((entry) => `"${entry}"`).join(", ")} in this scope; use cabinet_search to find it`);
			}
			return Promise.resolve({
				count: tools.length,
				tools,
				...missing.length > 0 ? { missing } : {}
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
			// Some provider bridges stringify nested object arguments, so the
			// model's patch can arrive as a JSON string. Coerce it rather than
			// rejecting a call the model cannot make any other way.
			let patch = args.patch;
			if (typeof patch === "string") {
				try {
					patch = JSON.parse(patch);
				} catch {
					throw new Error(`action "${args.action}": "patch" arrived as a string that is not valid JSON; pass an object or a JSON-encoded object`);
				}
			}
			if (patch === undefined || patch === null || typeof patch !== "object" || Array.isArray(patch)) {
				throw new Error(`action "${args.action}" requires a "patch" object`);
			}
			let proposed;
			try {
				proposed = normalizeConfig({ ...store.config, ...patch });
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
