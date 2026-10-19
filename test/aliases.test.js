import { test } from "node:test";
import assert from "node:assert/strict";
import { defineTool, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { createAliasRegistry, normalizeAliasArguments } from "../lib/aliases.js";

/**
 * Aliases exist because models reach for other harnesses' tool names. This
 * file pins the exact live failure: `read_client` (a real name in other
 * harnesses, and a dead name here) called with `file_path` while this
 * harness's tool is `read` and takes `path`. Four identical calls looped in a
 * real session and nothing in the error text suggested the right name.
 */

/** A registry-shaped target built the same way the harness builds its own tools. */
function makeTarget() {
	const calls = [];
	const read = defineTool({
		name: "read",
		description: "Read a UTF-8 text file and return line-numbered content.",
		parameters: {
			path: { type: "string", required: true, description: "Path to read." },
			offset: { type: "integer", description: "First line." },
			limit: { type: "integer", description: "Line count." }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: { type: "string", required: true } }
			},
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute(args) {
			calls.push(args);
			return Promise.resolve({ text: `read ${args.path} (limit ${args.limit ?? "none"})` });
		}
	});
	return { read, calls };
}

/** Minimal registry stub mirroring ctx.tools.register/get. */
function makeCtx(targets) {
	const registered = new Map();
	return {
		registered,
		ctx: {
			tools: {
				register(definition) {
					registered.set(definition.name, definition);
					return () => registered.delete(definition.name);
				},
				get(name) {
					return targets.get(name);
				}
			}
		}
	};
}

/** Config shape as normalizeConfig produces it. */
function config(aliases, enabled = true) {
	return { enabled, aliases };
}

const READ_CLIENT = {
	read_client: { target: "read", params: { file_path: "path" }, description: "" }
};

test("the read_client incident: a foreign name with a foreign parameter succeeds", async () => {
	const { read, calls } = makeTarget();
	const { ctx, registered } = makeCtx(new Map([["read", read]]));
	const aliases = createAliasRegistry(ctx);
	aliases.sync(config(READ_CLIENT));

	const alias = registered.get("read_client");
	assert.ok(alias, "the alias registered under the foreign name");

	const exec = { agent: undefined };
	const value = await alias.execute({ file_path: "F:/notes.md", limit: 3 }, exec);

	// The target saw this harness's parameter name, not the foreign one.
	assert.deepEqual(calls, [{ path: "F:/notes.md", limit: 3 }]);
	// Unmapped arguments pass through; the alias returns the target's rendered content.
	assert.deepEqual(value, { content: [{ type: "text", text: "read F:/notes.md (limit 3)" }] });
	assert.deepEqual(validateJsonSchemaValue(alias.output.schema, value, ""), []);
	assert.deepEqual(alias.output.render({}, value), value.content);
});

test("aliases answer to either parameter spelling (path or file_path)", async () => {
	const { read, calls } = makeTarget();
	const { ctx, registered } = makeCtx(new Map([["read", read]]));
	createAliasRegistry(ctx).sync(config(READ_CLIENT));
	const exec = { agent: undefined };

	await registered.get("read_client").execute({ path: "native.md" }, exec);
	await registered.get("read_client").execute({ file_path: "foreign.md" }, exec);
	assert.deepEqual(calls.map((call) => call.path), ["native.md", "foreign.md"]);
});

test("normalizeAliasArguments renames mapped keys and passes the rest through", () => {
	assert.deepEqual(
		normalizeAliasArguments({ file_path: "a", limit: 5 }, { file_path: "path" }),
		{ path: "a", limit: 5 }
	);
});

test("hot config swaps add, retarget and remove aliases", () => {
	const { ctx, registered } = makeCtx(new Map());
	const aliases = createAliasRegistry(ctx);

	aliases.sync(config({}));
	assert.equal(registered.size, 0);

	aliases.sync(config(READ_CLIENT));
	assert.ok(registered.has("read_client"));

	// Same spec: no re-registration churn.
	const first = registered.get("read_client");
	aliases.sync(config(READ_CLIENT));
	assert.equal(registered.get("read_client"), first, "unchanged spec keeps the same definition");

	// Retarget: the adapter is replaced.
	aliases.sync(config({ read_client: { target: "read_page", params: {}, description: "" } }));
	assert.notEqual(registered.get("read_client"), first);
	assert.equal(registered.get("read_client").description, 'Compatibility alias for "read_page".');

	// Removed from config: the tool is unregistered.
	aliases.sync(config({}));
	assert.equal(registered.size, 0);
});

test("a disabled cabinet registers no aliases, so none can reach the wire", () => {
	const { ctx, registered } = makeCtx(new Map());
	const aliases = createAliasRegistry(ctx);
	aliases.sync(config(READ_CLIENT, false));
	assert.equal(registered.size, 0);
});

test("an alias whose target is not registered fails loudly instead of no-opping", async () => {
	const { ctx, registered } = makeCtx(new Map());
	createAliasRegistry(ctx).sync(config(READ_CLIENT));

	await assert.rejects(
		() => registered.get("read_client").execute({ file_path: "x" }, { agent: undefined }),
		/alias "read_client" targets "read", which is not registered/
	);
});

test("dispose unregisters every alias", () => {
	const { ctx, registered } = makeCtx(new Map());
	const aliases = createAliasRegistry(ctx);
	aliases.sync(config({ a1: { target: "t1", params: {}, description: "" }, a2: { target: "t2", params: {}, description: "" } }));
	assert.equal(registered.size, 2);
	aliases.dispose();
	assert.equal(registered.size, 0);
});
test("the alias forwards the original exec, so fs observation keeps its owner", async () => {
	// Regression guard for the read-before-edit policy: it records observations
	// on fs/observed keyed by actor.agent.session. An adapter that minted a
	// fresh exec (no agent) would read fine and silently fail to satisfy it.
	const seen = [];
	const target = defineTool({
		name: "read",
		description: "Read a UTF-8 text file and return line-numbered content.",
		parameters: { path: { type: "string", required: true } },
		output: {
			schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
			render: () => [{ type: "text", text: "ok" }]
		},
		execute: (_args, exec) => {
			seen.push(exec);
			return Promise.resolve({ text: "ok" });
		}
	});

	const { ctx, registered } = makeCtx(new Map([["read", target]]));
	createAliasRegistry(ctx).sync(config(READ_CLIENT));

	const session = { id: "session-1" };
	const exec = { agent: { session } };
	await registered.get("read_client").execute({ file_path: "F:/x.md" }, exec);

	assert.equal(seen.length, 1, "the target ran");
	assert.equal(seen[0], exec, "the same exec object reached the target");
	assert.equal(seen[0].agent.session, session, "so the session owner survives for fs/observed");
});
