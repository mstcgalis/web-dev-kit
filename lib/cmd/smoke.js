// wdk smoke: every crawled page in every engine; fails on runtime errors,
// console.error, and broken same-origin requests. A document 404 is fine —
// /does-not-exist is a start path on purpose — but a document 5xx is not.
import { parseArgs } from 'node:util';
import { enginesFor, loadConfig } from '../config.js';
import { exeVisit, guard, launch, parseEngine } from '../engines.js';
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
	let browser = null; // launched lazily by fresh()
	const pathOf = (u) => new URL(u).pathname;
	const baseOrigin = new URL(base).origin;
	const own = (u) => new URL(u).origin === baseOrigin;
	const visit = async (path) => {
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
			if (e.message.includes('Timeout')) throw new Error(`browser stalled: ${e.message}`);
			fail(name, path, `navigation: ${e.message}`);
		} finally {
			await page.close();
		}
	};
	// A dead browser is replaced lazily, and a failed launch is retried: on CI runners Firefox
	// can die at newPage and again at the relaunch. A page that crashes or stalls the browser
	// gets one retry on a fresh one before it counts as a failure.
	const fresh = async () => {
		for (let i = 1; ; i++) {
			try {
				return await launch(name);
			} catch (e) {
				if (i === 3) throw e;
				await Bun.sleep(2000);
			}
		}
	};
	// A fully broken engine would otherwise cost 2 × 60s per page (~17 min for 41 pages):
	// after LOST pages in a row lose the browser, the rest are failed without trying.
	const LOST = 3;
	let lost = 0;
	try {
		for (const [i, path] of paths.entries()) {
			if (lost >= LOST) {
				for (const p of paths.slice(i)) fail(name, p, `not tried: ${LOST} pages in a row lost the browser`);
				break;
			}
			for (let attempt = 1; ; attempt++) {
				try {
					browser ??= await fresh();
					await guard(browser, visit(path));
					lost = 0;
					break;
				} catch (e) {
					if (!/^(browser |newPage:)/.test(e.message)) throw e;
					// ponytail: a stalled browser is abandoned, not closed (close() can hang too); it dies with wdk
					browser = null;
					if (attempt === 2) {
						lost++;
						fail(name, path, e.message);
						break;
					}
				}
			}
		}
	} finally {
		await Promise.race([browser?.close(), Bun.sleep(10_000)]); // close() on an unnoticed dead browser never returns
	}
}

// Old binaries have no driver: the proxy is the instrument. The beacon reports
// script errors; the proxy's own log reports broken same-origin requests.
async function smokeExe(engine, paths, proxy, fail) {
	for (const path of paths) {
		proxy.errors.length = 0;
		proxy.responses.length = 0;
		await exeVisit(engine, proxy.url + path);
		if (!proxy.responses.some((r) => r.path === path)) fail(engine.name, path, 'page never loaded (browser did not start or reach the proxy)');
		for (const e of proxy.errors) if (e.type !== 'resource') fail(engine.name, path, `${e.type}: ${e.msg}`);
		for (const r of proxy.responses) if (r.path !== '/favicon.ico' && r.status >= (r.path === path ? 500 : 400)) fail(engine.name, path, `${r.status} ${r.path}`);
	}
}
