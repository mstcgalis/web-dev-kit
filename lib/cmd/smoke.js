// kit smoke: every crawled page in every engine; fails on runtime errors,
// console.error, and broken same-origin requests. A document 404 is fine —
// /does-not-exist is a start path on purpose — but a document 5xx is not.
import { parseArgs } from 'node:util';
import { enginesFor, loadConfig } from '../config.js';
import { launch, parseEngine } from '../engines.js';
import { startProxy } from '../proxy.js';
import { crawl, startSite } from '../site.js';

export async function run(args) {
	const { values: o } = parseArgs({ args, options: { engines: { type: 'string' }, skip: { type: 'string' } } });
	const config = await loadConfig();
	if (o.skip) config.pages.skip = o.skip;
	const engines = enginesFor(config, o.engines).map(parseEngine);
	const site = await startSite();
	const proxy = startProxy({ origin: site.origin, knobs: config.perf.knobs, block: config.proxy.block });
	let failed = 0;
	const fail = (engine, path, reason) => {
		failed++;
		console.log(`✗ ${engine} ${path} — ${reason}`);
	};
	try {
		const paths = await crawl(site.origin, config.pages);
		for (const engine of engines) {
			if (engine.kind === 'playwright') await smokePlaywright(engine.name, paths, proxy.url, fail);
			else await smokeExe(engine, paths, proxy, fail);
		}
		console.log(`${paths.length} pages × ${engines.length} engine(s), ${failed} error(s)`);
	} finally {
		proxy.stop();
		site.stop();
	}
	return failed ? 1 : 0;
}

async function smokePlaywright(name, paths, base, fail) {
	const browser = await launch(name);
	const pathOf = (u) => new URL(u).pathname;
	const baseOrigin = new URL(base).origin;
	const own = (u) => new URL(u).origin === baseOrigin;
	try {
		for (const path of paths) {
			const page = await browser.newPage();
			page.on('pageerror', (e) => fail(name, path, `pageerror: ${e.message}`));
			// The browser's own "Failed to load resource" lines duplicate the response check below.
			page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && fail(name, path, `console.error: ${m.text()}`));
			// Aborted media range requests and requests cut off by page.close() are not a site issue.
			page.on('requestfailed', (r) => {
				if (!own(r.url())) return;
				const errorText = r.failure()?.errorText ?? '';
				if (errorText.includes('ERR_ABORTED') || errorText.includes('NS_BINDING_ABORTED') || errorText.includes('cancelled')) return;
				fail(name, path, `request failed: ${pathOf(r.url())} (${errorText})`);
			});
			page.on('response', (r) => {
				// Browsers fetch /favicon.ico unasked; a site without one is not broken.
				if (!own(r.url()) || pathOf(r.url()) === '/favicon.ico') return;
				const doc = r.request().isNavigationRequest() && r.request().frame() === page.mainFrame();
				if (r.status() >= (doc ? 500 : 400)) fail(name, path, `${r.status()} ${pathOf(r.url())}`);
			});
			try {
				await page.goto(base + path, { waitUntil: 'load' });
				await page.waitForTimeout(500); // ponytail: fixed settle; errors after this are missed
			} catch (e) {
				fail(name, path, `navigation: ${e.message}`);
			} finally {
				await page.close();
			}
		}
	} finally {
		await browser.close();
	}
}

async function smokeExe() {
	throw new Error('exe engines: Task 5');
}
