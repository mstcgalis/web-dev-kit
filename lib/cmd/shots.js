// wdk shots: a contact sheet for eyeballing layout across engines and viewports.
// Rows are pages; columns are engine × viewport; any error the page reported is
// noted under its cell. Report only — it never fails the build.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { enginesFor, loadConfig } from '../config.js';
import { exeLabel, exeScreenshot, guard, launch, parseEngine } from '../engines.js';
import { startProxy } from '../proxy.js';
import { crawl, startSite } from '../site.js';

const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export async function run(args) {
	const { values: o } = parseArgs({ args, options: { engines: { type: 'string' }, skip: { type: 'string' } } });
	const config = await loadConfig();
	if (o.skip) config.pages.skip = o.skip;
	const engines = enginesFor(config, o.engines).map(parseEngine);
	const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || 'nogit';
	const dir = resolve('.wdk', 'shots', `${new Date().toISOString().slice(0, 16).replace(/:/g, '')}-${sha}`);
	mkdirSync(dir, { recursive: true });
	const site = await startSite();
	const proxy = startProxy({ origin: site.origin, knobs: config.perf.knobs, block: config.proxy.block });
	const cols = []; // {id, label}
	const cells = new Map(); // `${col}|${path}` → {file, notes[]}
	const heights = new Map(); // `${width}|${path}` → scrollHeight, from the first Playwright engine
	try {
		const paths = await crawl(site.origin, config.pages);
		for (const engine of engines) {
			const label = engine.kind === 'playwright' ? engine.name : exeLabel(engine);
			const browser = engine.kind === 'playwright' ? await launch(engine.name) : null;
			try {
				for (const [w, h] of config.viewports) {
					const col = `${slug(label)}-${w}x${h}`;
					cols.push({ id: col, label: `${label} · ${w}×${h}` });
					const ctx = browser && (await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' }));
					for (const path of paths) {
						const file = `${col}-${slug(path)}.png`;
						const notes = [];
						const url = `${proxy.url}${path}${path.includes('?') ? '&' : '?'}wdk-freeze`;
						if (ctx) {
							// ponytail: a browser crash aborts the run (loudly) rather than relaunching
							const page = await guard(browser, ctx.newPage());
							page.on('pageerror', (e) => notes.push(`pageerror: ${e.message}`));
							try {
								await guard(browser, (async () => {
									await page.goto(url, { waitUntil: 'load' });
									if (!heights.has(`${w}|${path}`)) heights.set(`${w}|${path}`, await page.evaluate(() => document.documentElement.scrollHeight));
									await page.screenshot({ path: join(dir, file), fullPage: true, animations: 'disabled' });
								})());
							} catch (e) {
								notes.push(`navigation: ${e.message}`);
							} finally {
								await page.close();
							}
						} else {
							proxy.errors.length = 0;
							if (!(await exeScreenshot(engine, url, [w, h], join(dir, file), heights.get(`${w}|${path}`)))) notes.push('no screenshot (binary failed or timed out)');
							for (const e of proxy.errors) notes.push(`${e.type}: ${e.msg}`);
						}
						cells.set(`${col}|${path}`, { file, notes });
					}
					await ctx?.close();
				}
			} finally {
				await browser?.close();
			}
		}
		writeFileSync(join(dir, 'index.html'), sheet(paths, cols, cells, sha));
		console.log(`sheet: ${join(dir, 'index.html')}`);
	} finally {
		proxy.stop();
		site.stop();
	}
	return 0;
}

function sheet(paths, cols, cells, sha) {
	const head = cols.map((c) => `<th data-col="${esc(c.id)}">${esc(c.label)}</th>`).join('');
	const rows = paths
		.map((path) => {
			const tds = cols
				.map((c) => {
					const { file, notes } = cells.get(`${c.id}|${path}`);
					const list = notes.length ? `<ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
					return `<td><a href="${esc(file)}"><img src="${esc(file)}" loading="lazy" alt="${esc(`${path} in ${c.label}`)}"></a>${list}</td>`;
				})
				.join('');
			return `<tr data-path="${esc(path)}"><th scope="row">${esc(path)}</th>${tds}</tr>`;
		})
		.join('\n');
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>wdk shots ${esc(sha)}</title>
<style>body{font:13px system-ui;margin:1rem}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:4px;vertical-align:top}
td img{width:220px;display:block}th[scope=row]{position:sticky;left:0;background:#fff}thead th{position:sticky;top:0;background:#fff}ul{color:#b00;margin:4px 0;padding-left:1rem;max-width:220px}</style>
</head><body><table><thead><tr><th></th>${head}</tr></thead><tbody>
${rows}
</tbody></table></body></html>`;
}
