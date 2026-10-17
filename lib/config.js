/**
 * Hot-config store for the cabinet: load, validate, watch, and atomically
 * rewrite the dedicated JSON config file (default `$DSH_HOME/tool-cabinet.json`).
 *
 * The file is the source of truth; the in-memory `config` is a last-good
 * snapshot swapped in after every successful validation. An invalid write
 * keeps the last-good config and logs — the harness never runs with a
 * half-parsed cabinet.
 *
 * @module dsh-tool-cabinet/config
 */
import fs from "node:fs";
import path from "node:path";

/** Thrown for any invalid hot-config document; message lists every problem. */
export class CabinetConfigError extends Error {
	/** @param {string} message - combined problem list. */
	constructor(message) {
		super(message);
		this.name = "CabinetConfigError";
	}
}

/** Config written when the file does not exist yet — cabinet inert until edited. */
export const DEFAULT_CONFIG = Object.freeze({
	enabled: false,
	applyToScopes: "all",
	desk: [],
	unfiled: "visible",
	drawers: [],
	tags: {}
});

const SCOPE_SPECIAL = new Set(["all", "main"]);
const UNFILED_MODES = new Set(["visible", "drawer"]);
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function isStringArray(value) {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Validate and normalize a raw hot-config document.
 * @param {unknown} raw - parsed JSON value.
 * @returns {object} the normalized config (frozen-free plain object).
 * @throws {CabinetConfigError} listing every structural problem found.
 */
export function normalizeConfig(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new CabinetConfigError("config must be a JSON object");
	}
	const problems = [];
	const known = new Set(["enabled", "applyToScopes", "desk", "unfiled", "drawers", "tags"]);
	for (const key of Object.keys(raw)) {
		if (!known.has(key)) problems.push(`unknown key "${key}" (expected one of: ${[...known].join(", ")})`);
	}
	const enabled = raw.enabled ?? DEFAULT_CONFIG.enabled;
	if (typeof enabled !== "boolean") problems.push(`"enabled" must be a boolean (got ${typeof enabled})`);

	const applyToScopes = raw.applyToScopes ?? DEFAULT_CONFIG.applyToScopes;
	const scopesOk = SCOPE_SPECIAL.has(applyToScopes) || isStringArray(applyToScopes);
	if (!scopesOk) problems.push(`"applyToScopes" must be "all", "main", or an array of scope ids (got ${JSON.stringify(applyToScopes)})`);

	const desk = raw.desk ?? DEFAULT_CONFIG.desk;
	if (!isStringArray(desk)) problems.push('"desk" must be an array of tool names');

	const unfiled = raw.unfiled ?? DEFAULT_CONFIG.unfiled;
	if (!UNFILED_MODES.has(unfiled)) problems.push(`"unfiled" must be "visible" or "drawer" (got ${JSON.stringify(unfiled)})`);

	const drawers = raw.drawers ?? DEFAULT_CONFIG.drawers;
	const seenIds = new Set();
	if (!Array.isArray(drawers)) {
		problems.push('"drawers" must be an array');
	} else {
		drawers.forEach((drawer, index) => {
			const at = `drawers[${index}]`;
			if (drawer === null || typeof drawer !== "object" || Array.isArray(drawer)) {
				problems.push(`${at} must be an object`);
				return;
			}
			if (typeof drawer.id !== "string" || !ID_PATTERN.test(drawer.id)) {
				problems.push(`${at}.id must match ${ID_PATTERN} (got ${JSON.stringify(drawer.id)})`);
			} else if (seenIds.has(drawer.id)) {
				problems.push(`${at}.id "${drawer.id}" is duplicated`);
			} else {
				seenIds.add(drawer.id);
			}
			if (typeof drawer.label !== "string" || drawer.label.trim() === "") {
				problems.push(`${at}.label must be a non-empty string`);
			}
			if (drawer.description !== undefined && typeof drawer.description !== "string") {
				problems.push(`${at}.description must be a string when present`);
			}
			const match = drawer.match;
			if (match !== undefined) {
				if (match === null || typeof match !== "object" || Array.isArray(match)) {
					problems.push(`${at}.match must be an object`);
				} else {
					for (const key of Object.keys(match)) {
						if (!["names", "prefixes", "tags"].includes(key)) problems.push(`${at}.match has unknown key "${key}" (expected names|prefixes|tags)`);
						else if (!isStringArray(match[key])) problems.push(`${at}.match.${key} must be an array of strings`);
					}
				}
			}
		});
	}

	const tags = raw.tags ?? DEFAULT_CONFIG.tags;
	if (tags === null || typeof tags !== "object" || Array.isArray(tags)) {
		problems.push('"tags" must be an object mapping tool name -> tag array');
	} else {
		for (const [name, value] of Object.entries(tags)) {
			if (!isStringArray(value)) problems.push(`tags["${name}"] must be an array of strings`);
		}
	}

	if (problems.length > 0) throw new CabinetConfigError(problems.join("; "));
	return {
		enabled,
		applyToScopes,
		desk: [...desk],
		unfiled,
		drawers: drawers.map((drawer) => ({
			id: drawer.id,
			label: drawer.label,
			description: drawer.description ?? "",
			match: {
				names: [...(drawer.match?.names ?? [])],
				prefixes: [...(drawer.match?.prefixes ?? [])],
				tags: [...(drawer.match?.tags ?? [])]
			}
		})),
		tags: Object.fromEntries(Object.entries(tags).map(([name, value]) => [name, [...value]]))
	};
}

/**
 * Load + validate the config file. A missing file yields the inert default
 * (without writing it); a malformed file throws.
 * @param {string} filePath - absolute path of the hot config.
 * @returns {object} normalized config.
 */
export function loadConfigFile(filePath) {
	let text;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return normalizeConfig({});
		throw error;
	}
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new CabinetConfigError(`${filePath}: invalid JSON: ${error.message}`);
	}
	return normalizeConfig(raw);
}

/**
 * Atomically write the config (temp file + rename) so a watcher never reads
 * a torn document. The file's directory is created when missing.
 * @param {string} filePath - absolute path of the hot config.
 * @param {object} config - validated config to persist.
 */
export function writeConfigFile(filePath, config) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tempPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
	fs.renameSync(tempPath, filePath);
}

/** @typedef {{config: object, path: string, error: string | null, reload: () => void, dispose: () => void}} CabinetStore */

/**
 * Open the hot-config store: initial load, then a debounced fs watcher that
 * revalidates on every change. Invalid content keeps the last-good config and
 * is surfaced through `error` (and the supplied logger, when given).
 *
 * Watching the containing directory (filtered by basename) survives editors
 * and `writeConfigFile` that replace the inode, which a direct file watch on
 * Windows does not.
 *
 * @param {string} filePath - absolute path of the hot config.
 * @param {{logger?: {warn: (message: string) => void}, debounceMs?: number}} [options] - watch tuning.
 * @returns {CabinetStore} live store; call `dispose()` on unload.
 */
export function openConfigStore(filePath, options = {}) {
	const debounceMs = options.debounceMs ?? 120;
	const logger = options.logger;
	let config;
	let error = null;
	try {
		config = loadConfigFile(filePath);
	} catch (loadError) {
		config = normalizeConfig({});
		error = loadError.message;
		logger?.warn(`tool-cabinet: starting with the inert default config — ${loadError.message}`);
	}

	const baseName = path.basename(filePath);
	let timer;
	let watcher;
	const reload = () => {
		try {
			const next = loadConfigFile(filePath);
			config = next;
			if (error !== null) {
				error = null;
				logger?.warn("tool-cabinet: config recovered; applying the new cabinet");
			}
		} catch (reloadError) {
			// Keep last-good config; surface the problem for cabinet_config.
			error = reloadError.message;
			logger?.warn(`tool-cabinet: ignoring invalid config edit, keeping the last-good cabinet — ${reloadError.message}`);
		}
	};
	try {
		watcher = fs.watch(path.dirname(filePath), (_event, changedName) => {
			if (changedName !== null && changedName !== baseName) return;
			clearTimeout(timer);
			timer = setTimeout(reload, debounceMs);
		});
		watcher.on("error", (watchError) => {
			logger?.warn(`tool-cabinet: config watcher error (${watchError.message}); edits apply on restart`);
		});
	} catch (watchError) {
		logger?.warn(`tool-cabinet: cannot watch the config directory (${watchError.message}); edits apply on restart`);
	}

	return {
		get config() {
			return config;
		},
		get path() {
			return filePath;
		},
		get error() {
			return error;
		},
		reload,
		dispose() {
			clearTimeout(timer);
			watcher?.close();
		}
	};
}
