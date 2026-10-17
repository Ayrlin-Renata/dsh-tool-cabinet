# Integration seams — what to re-check when the harness updates

The plugin has no hard API ties beyond the seams below. When DSH ships a new
version (the `.pnpm` global dir hash changes — that's the first signal), walk
this list. Every check was load-bearing in the 0.1.5-rc.3 → 0.2.1-alpha.5 port.

Find the new runtime packages under the current global dir:

```
C:\Users\<you>\AppData\Local\pnpm\global\v11\<hash>\node_modules\.pnpm\
```

## 1. The peer-dependency gate (the reason plugins get disabled)

A new runtime *skips* the whole bundle if peer-deps on `@deepseek-ai/dsh-*`
don't match — this is what "disabled due to incompatibility" means. It is a
manifest-level check, not an API break. Shipped plugins pin the runtime version
exactly; do the same:

```json
"peerDependencies": {
  "@deepseek-ai/cordis": "~4.0.5-alpha.2",
  "@deepseek-ai/dsh-agent": "0.2.1-alpha.5",
  "@deepseek-ai/dsh-tools": "0.2.1-alpha.5",
  "@deepseek-ai/dsh-system-prompt": "0.2.1-alpha.5"
}
```

Mirror a shipped plugin's `package.json` (e.g. `dsh-tool-todo`) for the current
convention. Escape hatch for testing before an update: `dsh plugin allow-version
dsh-tool-cabinet@<ver> --dsh-version <exact> --accept-risk`.

Diagnose with `dsh --profile web --dump-config 2>&1 | Select-String "skipping"`
— that prints the exact failing requirements.

## 2. Injected service names

`inject: ["tools", "systemPrompt", "agents"]` must name services that still
exist. Grep for their construction:

- `dsh-tools` → `global: "tools"` (ToolRuntime, `extends Service`)
- `dsh-system-prompt` → `super(ctx, "systemPrompt")`
- `dsh-agent` → `super(ctx, "agents")` (AgentRegistry)

## 3. `system-prompt/assemble` waterfall (the filtering seam)

The single global listener that partitions `assembly.tools`. Check the event
name and the post-`next()` transform pattern still fit:

```js
ctx.on("system-prompt/assemble", async (assembly, context, next) => {
  const assembled = await next();          // filter AFTER the inner chain
  return { ...assembled, tools: visible };
});
```

- Event fires as `"system-prompt/assemble"` (dsh-system-prompt `assemble()`).
- `PromptAssembly` = `{ sections, contexts, tools, variables }`.
- **`toolOrder` (new in 0.2)**: validated *before* the waterfall. Unconfigured →
  lexicographic sort; our partition preserves incoming order, so no impact. If
  a config ever sets `toolOrder`, it must contain `"<unlisted-tools>"` — but we
  never set it.
- A `complete` section is restored *after* the waterfall — we don't add one.

## 4. Tool registration + output validation

`defineTool(options)` — `{ name, description, parameters, output: { schema,
render }, execute(args, exec) }`. `parameters` DSL compiles via
`parameterSchemaSpecToJsonSchema`; outputs are validated against the compiled
`output.schema` at dispatch.

- Regression tests drive real `execute()` and validate results with the
  harness's own `validateJsonSchemaValue` (exported from `dsh-tools`). If that
  export ever moves, tests fail loudly — good.
- Schema DSL gotcha: `required: true` on a property spec means "required **in
  its parent**" — a `required` inside a shared sub-schema (like `DIFF_SCHEMA`)
  silently makes it mandatory everywhere it's spread.

## 5. Prompt-section APIs and ordering

- `ctx.systemPrompt.section({ name, order, text })` / `.tools(provider)` —
  layer-effect registrations.
- Section order `4950` (ours) must stay inside the tool block: TOOL_* orders are
  1000–3000, `TOOLS_SDK` 5000, `HARNESS_SOURCE` 10000.
- PTC no-op detection keys on the section name `tools:ptc-only` (and
  `tools:sdk`). If renamed, the PTC guard breaks.

## 6. Scope gating

`AgentRegistry.roots()` (main-agent plane, `owner === void 0`) implements
`applyToScopes: "main"`. Also used: `ctx.tools.schemas(exec.agent)` in the
cabinet tools for per-scope listings.

## 7. Schemastery quirks (not zod)

`z.string().optional()` **does not exist** — this crashed the boot once. Fields
are optional by default; `.required()` opts in; chainables are
`description/min/max/default/...`.

## 8. Bundle manifest

`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` + `exports`/`files`
entries for `cordis.patch.yml`. Without it the plugin installs as a plain
dependency and never activates.

## Verification procedure after an update

1. Bump peer-deps to the new exact runtime version; `pnpm install`.
2. `pnpm test` (27 tests) — proves `defineTool`/validator/schemastery behavior
   against the new packages, not just that they parse.
3. Push to GitHub, then in the profile:
   `dsh plugin --profile web update dsh-tool-cabinet`, restart.
4. Live check: `cabinet_list` should return tool totals. `cabinet_config get`
   should return without `wireDiff`.
