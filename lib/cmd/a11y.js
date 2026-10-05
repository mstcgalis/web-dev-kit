// kit a11y: axe-core (WCAG 2.2 AA + best practice) over every crawled page. Any violation fails.
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { loadConfig } from '../config.js';
import { crawl, startSite } from '../site.js';

export async function run(args) {
	const { values: o } = parseArgs({ args, options: { skip: { type: 'string' } } });
	const config = await loadConfig();
	if (o.skip) config.pages.skip = o.skip;
	const axePath = createRequire(import.meta.url).resolve('axe-core');
	const site = await startSite();
	let failed = 0;
	let browser;
	try {
		const paths = await crawl(site.origin, config.pages);
		// channel 'chromium': the full build in new-headless mode. nixpkgs' Linux browsers
		// ship it; the separate headless shell is not guaranteed there.
		browser = await chromium.launch({ channel: 'chromium' });
		const page = await browser.newPage();
		for (const path of paths) {
			await page.goto(site.origin + path);
			await page.addScriptTag({ path: axePath });
			const { violations } = await page.evaluate(() => axe.run({ runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }));
			for (const v of violations) {
				failed++;
				console.log(`✗ ${path} — ${v.id} (${v.impact}): ${v.help}`);
				for (const n of v.nodes.slice(0, 3)) console.log(`    ${n.target.join(' ')}`);
			}
		}
		console.log(`${paths.length} pages, ${failed} violation(s)`);
	} finally {
		await browser?.close();
		site.stop();
	}
	return failed ? 1 : 0;
}
