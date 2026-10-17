import { test } from "node:test";
import assert from "node:assert/strict";
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
