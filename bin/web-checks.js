#!/usr/bin/env bun
// web-checks a11y — axe-core over every same-origin page reachable from the
// start paths. Any violation fails the run.
//
//   web-checks a11y --dir dist
//   web-checks a11y --serve "php -S localhost:{port} router.php" --start / --start /cs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values: opt, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		dir: { type: 'string' }, // static site root, served by bun
		serve: { type: 'string' }, // shell command that serves the site; {port} is substituted
		port: { type: 'string', default: '8798' },
		start: { type: 'string', multiple: true, default: ['/', '/does-not-exist'] },
		skip: { type: 'string' }, // regex on the pathname, in addition to file extensions
		limit: { type: 'string', default: '80' }, // ponytail: crawl cap; raise per project
	},
});
if (positionals[0] !== 'a11y' || !opt.dir === !opt.serve) {
	console.error('usage: web-checks a11y (--dir <path> | --serve "<cmd with {port}>") [--port N] [--start /path]… [--skip regex] [--limit N]');
	process.exit(2);
}

const origin = `http://localhost:${opt.port}`;
const skip = new RegExp(opt.skip ? `${opt.skip}|\\.\\w+$` : '\\.\\w+$');
const limit = Number(opt.limit);
const axePath = createRequire(import.meta.url).resolve('axe-core');

const server = opt.dir ? serveDir(opt.dir) : serveCmd(opt.serve);
let failed = 0;
let seen;
try {
	for (let i = 0; ; i++) {
		if (await fetch(origin).then(() => true, () => false)) break;
		if (i > 50) throw new Error(`nothing answered on ${origin}`);
		await Bun.sleep(100);
	}

	const browser = await chromium.launch();
	const page = await browser.newPage();
	const queue = [...opt.start];
	seen = new Set(queue);
	for (const path of queue) {
		await page.goto(origin + path);
		await page.addScriptTag({ path: axePath });
		const { violations } = await page.evaluate(() => axe.run({ runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }));
		for (const v of violations) {
			failed++;
			console.log(`✗ ${path} — ${v.id} (${v.impact}): ${v.help}`);
			for (const n of v.nodes.slice(0, 3)) console.log(`    ${n.target.join(' ')}`);
		}
		for (const href of await page.$$eval('a[href]', (as) => as.map((a) => a.href))) {
			const u = new URL(href);
			if (u.origin !== origin || skip.test(u.pathname)) continue;
			if (!seen.has(u.pathname) && seen.size < limit) seen.add(u.pathname) && queue.push(u.pathname);
		}
	}
	await browser.close();
	console.log(`${seen.size} pages, ${failed} violation(s)`);
} finally {
	server.stop();
}
process.exit(failed ? 1 : 0);

function serveCmd(cmd) {
	const child = spawn(cmd.replaceAll('{port}', opt.port), { shell: true, stdio: 'ignore', detached: true });
	// Kill the whole group: `shell: true` puts the real server one process down.
	return { stop: () => process.kill(-child.pid) };
}

// Static hosting the way Netlify/nginx do it: /x → x, x.html or x/index.html; else 404.html.
function serveDir(dir) {
	return Bun.serve({
		port: Number(opt.port),
		async fetch(req) {
			const p = join(dir, decodeURIComponent(new URL(req.url).pathname));
			for (const f of [p, `${p}.html`, join(p, 'index.html')]) {
				if (statSync(f, { throwIfNoEntry: false })?.isFile()) return new Response(Bun.file(f));
			}
			const notFound = Bun.file(join(dir, '404.html'));
			return new Response((await notFound.exists()) ? notFound : 'Not found', { status: 404, headers: { 'content-type': 'text/html' } });
		},
	});
}
