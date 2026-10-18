# dsh-tool-cabinet

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent a **tool cabinet**: a small set of tools stays on the desk (definitions injected every turn), while the rest live in labeled drawers. The agent always knows the drawer headings and the total tool count, but only the desk tools' full schemas are injected each turn — so with hundreds of registered tools, the per-turn prompt carries a compact index instead of every definition.

This is a *soft* compartmentalization: hidden tools remain callable by exact name. Dispatch (`ctx.tools.executionMode/exec`) is never touched — only the assembled wire schemas are filtered. A tool the agent discovers via the cabinet tools is callable in the same turn.

## How it works

- **One `system-prompt/assemble` waterfall listener** (global scope) partitions each assembly's tool schemas into desk (pass-through) and drawers (removed from the wire list) using the current hot config. It runs after `next()`, so it sees the final assembled tools, and returns the assembly unchanged when nothing differs.
- **A `tools:cabinet-index` prompt section** renders the drawer headings (labels + descriptions from config only — no live tool names or counts, so the KV prefix is stable across tool registrations). It drops to empty when disabled or for an ungoverned scope.
- **PTC no-op**: when the scope's presentation is PTC (`tools:ptc-only` section rendered), the listener does nothing — the registry has already collapsed the wire list to `run_code`.
- **Hot config** in a dedicated JSON file (default `$DSH_HOME/tool-cabinet.json`), watched with a debounced `fs.watch` on the containing directory. Edits validate and swap in-memory live; an invalid edit keeps the last-good cabinet and logs a warning.

## Cabinet tools (always on the desk)

| Tool | Purpose |
| --- | --- |
| `cabinet_list` | Overview: drawers with their tools, desk tools, totals. With a drawer id, lists that drawer's tools with descriptions — add `withSchemas: true` to get that drawer's **full parameter schemas in one call** (drawer-scoped only: whole-cabinet schema dumps are refused, since they would re-inject everything the cabinet exists to hide). The **first call in a session** also returns a short guide to how the cabinet works (re-show with `help: true`, suppress with `help: false`). |
| `cabinet_search` | Keyword search across every tool (name, description, drawer label — a label matches only the tools **inside** that drawer). Each match includes the tool's **full parameter schema**, and the rendered text carries those schemas, so it is callable in the same turn. |
| `cabinet_show` | One tool's complete definition (description, parameters, placement). |
| `cabinet_config` | Read / preview / set the hot config. `preview` reports the wire-set diff *before* writing; `set` validates, writes atomically (temp + rename), and applies immediately. |

## Configuration

The hot config file (JSON). See `config.example.json` for a full example.

```json
{
  "enabled": true,
  "applyToScopes": "all",
  "desk": ["read", "write"],
  "unfiled": "visible",
  "drawers": [
    { "id": "browser", "label": "Browser control",
      "description": "Drive the shared browser.",
      "match": { "prefixes": ["browser_"] } }
  ],
  "tags": { "subagent": ["orchestration"] }
}
```

- **`enabled`** (default `false`): master switch. When false the cabinet is a complete no-op — every tool is injected as usual.
- **`applyToScopes`** (default `"all"`): `"all"` | `"main"` (top-level agents only, subagents unaffected) | array of exact agent/session ids.
- **`desk`**: tool names always injected directly.
- **`unfiled`** (default `"visible"`): `"visible"` keeps tools no drawer matched on the wire (fail-safe — new tools are never silently hidden); `"drawer"` withholds them into an implicit `unfiled` drawer.
- **`drawers`**: ordered list; each has `id` (slug), `label`, optional `description`, and `match` with any of `names` (exact), `prefixes` (name prefix), `tags` (from the `tags` map). First matching drawer claims a tool; precedence inside a drawer is names → prefixes → tags.
- **`tags`**: map of tool name → tag array (the registry schema carries no plugin attribution, so plugin-style grouping is done here).

The four cabinet tools are self-exempt (always visible) regardless of config — if they were filed away, nothing could open the drawers.

## Install

The package declares a `dsh.bundle` (see `cordis.patch.yml` in the repo root), so `dsh plugin add` installs it as a full profile layer: it is appended to `dsh.profile.bundles` and its patch row mounts the plugin automatically — no manual `cordis.patch.yml` edit is needed.

```
dsh plugin --profile <name> add F:\Fun\Tools\DeepSeekHarness\dsh-tool-cabinet
```

The bundled patch row is `id: tool-cabinet, name: dsh-tool-cabinet, config: {}`. To change the mount config (e.g. point at a different hot-config file), override the row by id in the profile's own `cordis.patch.yml`, which is applied after every bundle layer:

```yaml
- id: tool-cabinet
  config:
    configPath: "C:/path/to/tool-cabinet.json"
```

The plugin mounts against `tools`, `systemPrompt`, and `agents` services. Its dependencies are the small first-party packages (`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-system-prompt`, `@deepseek-ai/dsh-home-paths`, `@deepseek-ai/schemastery`, `@deepseek-ai/cordis`), provided by the profile at runtime.

## Design notes / limits

- **Soft only**: filtering affects what is *injected*, never what *dispatches*. `restrict()` and guards are deliberately untouched.
- **Subagents**: by default the cabinet governs all scopes. Set `applyToScopes: "main"` to leave subagent scopes untouched (their factories often restrict tools themselves).
- **PTC deployments**: no-op by design; the cabinet only filters native tool-schema presentation.
- **Prompt stability**: the headings section and wire list only change when the hot config changes or a tool registers/unregisters — config-authored section text avoids per-turn KV churn.
- **Unmatched tools** are visible by default (`unfiled: "visible"`); flip to `"drawer"` for strict compartmentalization.
- **HMR recompose can drop the fiber**: editing a profile patch file under `patchReload: live` recomposes the plugin tree, and a rebuild does not always restore every fiber — the cabinet's tools can then return `Error: unknown tool "cabinet_list"`. This is not a plugin fault (`apply` is re-entry-safe and returns a disposer for its watcher); it is a DSH lifecycle behavior, and it took browser and doctor plugins down in the same observed event. The config file on disk survives intact, so no settings are lost — a restart restores the cabinet. A repair tool would not help here: it would be registered by the very fiber that dies, so it would be unavailable exactly when needed. The `cabinet_list` help text describes this to the agent, so a silent disappearance reads as a known condition rather than an unexplained error.

## Development

```
npm test          # node --test, no harness install needed for the pure modules
```

`lib/partition.js` and `lib/config.js` are dependency-free by design; `lib/index.js` and `lib/tools.js` import the DSH packages and need the profile install to load.
