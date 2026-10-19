/**
 * dsh-tool-cabinet — hot-configurable tool compartmentalization.
 *
 * One global `system-prompt/assemble` waterfall listener partitions each
 * assembly's tool schemas into desk (pass-through) and drawers (removed from
 * the wire schemas), so the model stays aware of capability headings and the
 * total tool count while only desk-tool definitions are injected each turn.
 * Dispatch is never touched: a drawer tool remains callable by exact name
 * (soft mode), and `restrict()`/guards are out of scope by design.
 *
 * The hot config lives in a dedicated JSON file (default
 * `$DSH_HOME/tool-cabinet.json`), loaded at start and hot-swapped by a
 * debounced file watcher; an invalid edit keeps the last-good cabinet.
 *
 * @module dsh-tool-cabinet
 */
import z from "@deepseek-ai/schemastery";
import { dshHomePath, expandHomePath } from "@deepseek-ai/dsh-home-paths";
import { openConfigStore } from "./config.js";
import { partition } from "./partition.js";
import { registerCabinetTools } from "./tools.js";
import { createAliasRegistry } from "./aliases.js";

/** Plugin name (cordis fiber identity / logger name). */
const name = "tool-cabinet";
/** Services this plugin mounts against. */
const inject = ["tools", "systemPrompt", "agents"];
/** Cordis mount config: only the hot-config path is overridable (schemastery fields are optional by default). */
const Config = z.object({
	configPath: z.string().description("Absolute path of the hot config file (default $DSH_HOME/tool-cabinet.json).")
});

/** Section order just ahead of TOOLS_SDK (5000): the cabinet index precedes the tool SDK section. */
const CABINET_SECTION_ORDER = 4950;
/** Prompt section name; unique so a scoped duplicate registration throws loudly. */
const CABINET_SECTION_NAME = "tools:cabinet-index";

/**
 * Whether the cabinet governs one assembly scope. `"all"` governs every
 * scope; `"main"` governs top-level (root) agents only; a string array
 * governs exactly the listed agent ids. An assembly without a scope is
 * governed only by `"all"`.
 * @param {object} config - validated cabinet config.
 * @param {object | undefined} scope - the assembly's scope (an Agent), when any.
 * @param {{roots: () => object[]}} agents - the agent registry.
 * @returns {boolean} true when wire filtering applies to this assembly.
 */
function scopeGoverned(config, scope, agents) {
	if (config.applyToScopes === "all") return true;
	if (scope === undefined) return false;
	if (config.applyToScopes === "main") {
		// Roots are agents created without an owning parent; subagents are
		// entered under a parent, so roots() is exactly the main plane.
		return agents.roots().includes(scope);
	}
	return config.applyToScopes.includes(scope.id);
}

/**
 * Whether an assembly presents PTC (generated SDK) instead of native tool
 * schemas. In PTC mode the registry provider already collapsed the wire list
 * to `run_code`, so compartmentalization is a no-op by design.
 * @param {{sections: Array<{name: string, text: string}>}} assembly - the assembled prompt.
 * @returns {boolean} true when the ptc-only section rendered non-empty.
 */
function ptcActive(assembly) {
	return assembly.sections.some((section) => section.name === "tools:ptc-only" && section.text !== "");
}

/**
 * Render the cabinet index from CONFIG-AUTHORED text only (labels and
 * descriptions — no live tool names or counts), so the KV prefix changes only
 * when the hot config changes, never on tool registration churn.
 * @param {object} config - validated cabinet config.
 * @returns {string} the section text, or "" when there is nothing to show.
 */
function renderIndex(config) {
	if (!config.enabled) return "";
	const lines = [
		"## Tool cabinet",
		"",
		"This harness keeps most of its tools in drawers rather than loading every definition each turn. The tools on the desk are always available directly; the drawers below are labeled capability groups. To use tools from a drawer: `cabinet_search` (keyword — returns full parameter schemas for every match in one call) or `cabinet_show` (one or several exact names); `cabinet_list` shows the full inventory including the total tool count. Any tool you find is callable by its exact name in the same turn — look up several at once rather than one at a time."
	];
	if (config.drawers.length > 0) {
		lines.push("", "Drawers:");
		for (const drawer of config.drawers) {
			lines.push(`- ${drawer.id} — ${drawer.label}${drawer.description === "" ? "" : `: ${drawer.description}`}`);
		}
	}
	return lines.join("\n");
}

/**
 * Mount the cabinet: open the hot config, register the assemble waterfall,
 * the prompt section, and the four cabinet tools.
 * @param {object} ctx - plugin context carrying tools/systemPrompt/agents.
 * @param {object} config - cordis mount config ({configPath?}).
 * @returns {() => void} disposer closing the config watcher.
 */
function apply(ctx, config) {
	const logger = ctx.logger(name);
	const configPath = config?.configPath === undefined
		? dshHomePath("tool-cabinet.json")
		: expandHomePath(config.configPath);
	// Aliases follow the hot config: registered as real (hidden) tools so
	// dispatch finds them, re-synced on every successful config swap.
	const aliasRegistry = createAliasRegistry(ctx, { logger });
	const store = openConfigStore(configPath, { logger, onChange: (next) => aliasRegistry.sync(next) });
	aliasRegistry.sync(store.config);

	// Soft compartmentalization: filter the assembled wire schemas only.
	// Dispatch (`ctx.tools.executionMode/exec`) never consults this list, so
	// hidden tools stay callable by exact name.
	ctx.on("system-prompt/assemble", async (assembly, context, next) => {
		const assembled = await next();
		const cabinetConfig = store.config;
		if (!cabinetConfig.enabled) return assembled;
		if (!scopeGoverned(cabinetConfig, context.scope, ctx.agents)) return assembled;
		if (ptcActive(assembled)) return assembled;
		const schemas = assembled.tools ?? [];
		const { visible } = partition(schemas, cabinetConfig);
		// No real difference: keep the same object so downstream header
		// comparison sees an unchanged wire list.
		if (visible.length === schemas.length) return assembled;
		return { ...assembled, tools: visible };
	});

	// The headings section: config-authored drawer labels only. Its text
	// provider is evaluated per assembly, so an ungoverned scope or a
	// disabled cabinet renders empty (empty sections are dropped).
	ctx.systemPrompt.section({
		name: CABINET_SECTION_NAME,
		order: CABINET_SECTION_ORDER,
		text: (context) => {
			const cabinetConfig = store.config;
			if (!cabinetConfig.enabled) return "";
			if (!scopeGoverned(cabinetConfig, context.scope, ctx.agents)) return "";
			return renderIndex(cabinetConfig);
		}
	});

	registerCabinetTools(ctx, { store });
	return () => {
		aliasRegistry.dispose();
		store.dispose();
	};
}

export { Config, apply, inject, name };
