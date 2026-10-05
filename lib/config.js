// The project's kit.config.js over the defaults. Every key is optional.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULTS = {
	pages: { start: ['/', '/does-not-exist'], skip: '', limit: 80 }, // ponytail: crawl cap; raise per project
	engines: { ci: ['chromium'], local: ['chromium'] },
	viewports: [[390, 844], [1440, 900]],
	compat: { css: [], targets: 'defaults', allow: [] },
	proxy: { block: [] },
	perf: { page: '/', knobs: {} },
};

export async function loadConfig(dir = process.cwd()) {
	const file = join(dir, 'kit.config.js');
	const user = existsSync(file) ? (await import(file)).default : {};
	const config = {};
	for (const [key, value] of Object.entries(DEFAULTS)) {
		config[key] = Array.isArray(value) ? (user[key] ?? value) : { ...value, ...user[key] };
	}
	return config;
}

// --engines wins; then CI's list on CI, the local list everywhere else.
export function enginesFor(config, override) {
	if (override) return override.split(',').filter(Boolean);
	return process.env.CI ? config.engines.ci : config.engines.local;
}
