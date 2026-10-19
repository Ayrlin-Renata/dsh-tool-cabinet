/**
 * Compatibility aliases: registered adapter tools that answer to a foreign
 * tool name (and/or a foreign parameter spelling), normalize the arguments,
 * and delegate to the real tool.
 *
 * Why these exist: models trained on other harnesses reach for familiar names
 * (`read_client`, `shell`, …) that this registry does not dispatch, and an
 * `unknown tool` error carries no hint, so the agent can loop on the wrong
 * name. An alias makes that call succeed on the first attempt.
 *
 * Why they cost nothing: aliases are hidden from the wire by `partition()` —
 * registered (so dispatch finds them) but never injected. The agent only
 * learns about them if it explicitly opens the `aliases` cabinet.
 *
 * Delegation calls the target's own `execute`, so the target's argument
 * validation and body run exactly as they would for a direct call. Registry
 * guards/pre-execute hooks do not run for the nested call: an alias is a
 * dispatch shim, not a bypass of the target's own contract.
 *
 * @module dsh-tool-cabinet/aliases
 */
import { aliasNames } from "./partition.js";

/** Output contract shared by every alias: the target's rendered content, verbatim. */
const CONTENT_SCHEMA = Object.freeze({
	type: "object",
	additionalProperties: false,
	properties: {
		content: { type: "array", items: { type: "object", additionalProperties: true } }
	},
	required: ["content"]
});

/**
 * Rename the incoming arguments into the target's parameter namespace.
 * Unmapped keys pass through unchanged (a shim should not silently drop an
 * argument the target may accept).
 * @param {object} args - the args the model sent to the alias.
 * @param {Record<string, string>} params - incoming name -> target name.
 * @returns {object} arguments in the target's namespace.
 */
export function normalizeAliasArguments(args, params) {
	const mapped = {};
	for (const [key, value] of Object.entries(args ?? {})) mapped[params[key] ?? key] = value;
	return mapped;
}

/**
 * Build the registry definition for one alias. Registered raw (not through
 * `defineTool`) because the alias parameter schema must stay open: the whole
 * point is to accept calls shaped for another harness, so nothing can be
 * required and unknown keys must be allowed through to the target.
 * @param {object} ctx - context carrying the tool registry.
 * @param {string} aliasName - the foreign name.
 * @param {{target: string, params: Record<string, string>, description: string}} spec - normalized spec.
 * @returns {object} a ToolDefinition.
 */
function aliasDefinition(ctx, aliasName, spec) {
	return {
		name: aliasName,
		description: spec.description !== "" ? spec.description : `Compatibility alias for "${spec.target}".`,
		parameters: { type: "object", additionalProperties: true },
		output: {
			schema: CONTENT_SCHEMA,
			render: (_args, value) => value.content
		},
		async execute(args, exec) {
			const target = ctx.tools.get(spec.target, exec.agent);
			// Resolve at call time: a target whose plugin fiber is down must fail
			// loudly here instead of masking as a silent no-op.
			if (target === undefined) {
				throw new Error(`alias "${aliasName}" targets "${spec.target}", which is not registered in this scope (its plugin may be down)`);
			}
			const normalized = normalizeAliasArguments(args, spec.params);
			const value = await target.execute(normalized, exec);
			const content = target.output.render(normalized, value);
			return { content: Array.isArray(content) ? content : [] };
		}
	};
}

/** Stable spec fingerprint, so an edited spec re-registers its adapter. */
function fingerprint(spec) {
	return JSON.stringify([spec.target, spec.params, spec.description]);
}

/**
 * Keep the registry's alias tools in sync with the hot config.
 *
 * Aliases follow the cabinet's `enabled` switch: a disabled cabinet registers
 * nothing, which also guarantees no alias can leak onto the wire while the
 * assemble waterfall is inert.
 *
 * @param {object} ctx - context carrying the tool registry.
 * @param {{logger?: {warn: (message: string) => void}}} [options] - diagnostics.
 * @returns {{sync: (config: object) => void, dispose: () => void}} live registry.
 */
export function createAliasRegistry(ctx, options = {}) {
	const logger = options.logger;
	/** @type {Map<string, {spec: string, dispose: () => void}>} */
	const registered = new Map();

	const sync = (config) => {
		const wanted = config.enabled ? config.aliases : {};
		for (const [name, entry] of [...registered]) {
			if (!Object.hasOwn(wanted, name) || fingerprint(wanted[name]) !== entry.spec) {
				entry.dispose();
				registered.delete(name);
			}
		}
		for (const [name, spec] of Object.entries(wanted)) {
			if (registered.has(name)) continue;
			try {
				const dispose = ctx.tools.register(aliasDefinition(ctx, name, spec));
				registered.set(name, { spec: fingerprint(spec), dispose });
			} catch (error) {
				logger?.warn(`tool-cabinet: cannot register alias "${name}" -> "${spec.target}": ${error.message}`);
			}
		}
	};

	return {
		sync,
		dispose() {
			for (const entry of registered.values()) entry.dispose();
			registered.clear();
		}
	};
}

/** Alias names configured under one cabinet config. */
export { aliasNames };
