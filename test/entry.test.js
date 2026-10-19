import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { name, inject, Config, apply } from "../lib/index.js";

test("plugin entry exports the cordis module contract", () => {
	assert.equal(name, "tool-cabinet");
	assert.deepEqual(inject, ["tools", "systemPrompt", "agents"]);
	assert.equal(typeof apply, "function");
});

test("Config is a valid schema that accepts empty and partial configs", () => {
	// The exact crash class a boot-time import would hit: a bad Schema chain
	// (e.g. z.string().optional()) throws when the module is evaluated, not
	// here — but parsing exercises the compiled schema end to end.
	assert.deepEqual(Config({}), {});
	assert.equal(Config({ configPath: "C:/tmp/tool-cabinet.json" }).configPath, "C:/tmp/tool-cabinet.json");
});

test("apply is callable with a bare context (module evaluation sanity)", () => {
	// Guards against future module-level API mistakes: the Config schema and
	// exported bindings must all evaluate on import (they already did if we
	// got this far), and apply must be a function, not undefined.
	assert.ok(apply.length >= 1);
});
/** A target tool shaped like the harness's own, for the wiring test. */
function makeReadTool() {
	return defineTool({
		name: "read",
		description: "Read a UTF-8 text file and return line-numbered content.",
		parameters: { path: { type: "string", required: true } },
		output: {
			schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: (args) => Promise.resolve({ text: `read ${args.path}` })
	});
}

test("apply wires aliases: registered as tools, absent from the assembled wire", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-entry-"));
	const file = path.join(dir, "tool-cabinet.json");
	fs.writeFileSync(file, JSON.stringify({
		enabled: true,
		aliases: { read_client: { target: "read", params: { file_path: "path" } } }
	}), "utf8");

	const readTool = makeReadTool();
	const registered = new Map();
	const listeners = [];
	const sections = [];
	const ctx = {
		logger: () => ({ warn() {}, info() {} }),
		on(event, handler) {
			listeners.push({ event, handler });
		},
		systemPrompt: {
			section(definition) {
				sections.push(definition);
			}
		},
		agents: { roots: () => [] },
		tools: {
			register(definition) {
				registered.set(definition.name, definition);
				return () => registered.delete(definition.name);
			},
			get(toolName) {
				return toolName === "read" ? readTool : undefined;
			},
			schemas() {
				return [];
			}
		}
	};

	const dispose = apply(ctx, { configPath: file });
	try {
		// The alias exists as a real registered tool...
		assert.ok(registered.has("read_client"), "alias registered through apply()");
		assert.deepEqual([...registered.keys()].filter((key) => key.startsWith("cabinet_")).sort(), ["cabinet_config", "cabinet_list", "cabinet_search", "cabinet_show"]);
		// ...and it delegates with the parameter renamed.
		const value = await registered.get("read_client").execute({ file_path: "notes.md" }, { agent: undefined });
		assert.deepEqual(value, { content: [{ type: "text", text: "read notes.md" }] });

		// ...but the assemble waterfall keeps it off the wire.
		const listener = listeners.find((entry) => entry.event === "system-prompt/assemble");
		assert.ok(listener, "assemble waterfall registered");
		const wire = (toolName) => ({ name: toolName, description: `${toolName} tool`, parameters: {} });
		const assembled = { sections: [], contexts: [], variables: {}, tools: [wire("read"), wire("read_client"), wire("other")] };
		const result = await listener.handler(assembled, { scope: undefined }, () => Promise.resolve(assembled));
		assert.deepEqual(result.tools.map((tool) => tool.name), ["read", "other"]);
	} finally {
		dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
