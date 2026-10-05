# web-kit checks module: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `web-checks` (one `a11y` command) into `web-kit`'s `kit` CLI. It has `a11y`, `compat`,
`smoke`, `shots` and `perf`, is delivered as a Nix flake with stack dev shells, and sonda-web
migrates onto it.

**Architecture:** `bin/kit.js` dispatches to `lib/cmd/<command>.js`, which share five single-job
modules:
- `config.js` reads `kit.config.js`.
- `site.js` starts the project's own `just serve-at PORT` and crawls it.
- `proxy.js` rewrites pages: knobs, an error beacon, a read-only guard.
- `engines.js` covers Playwright engines and `exe:` binaries.
- `cpu.js` is the macOS process-tree sampler.

The flake pins the kit, its `node_modules`, Linux Playwright browsers, and a macOS FF115.

**Tech Stack:** Bun 1.3 (runtime and `bun test`), Playwright 1.63.0, axe-core, doiuse + postcss,
Nix flakes (nixos-26.05, plus nixos-unstable only for `playwright-driver`), just.

**Spec:** `docs/superpowers/specs/2026-10-05-kit-contract-and-checks-design.md`. Out-of-scope items
are in `docs/roadmap.md`.

## Global Constraints

- The kit repo is `~/src/web-checks` (renamed `web-kit` in Task 8). Sonda is `~/src/sonda-web`,
  branch `dev`.
- Work in the kit on branch `web-kit`, never on `main`, until the Task 8 release.
- Bun only (never npm/npx/pnpm). Licence AGPL-3.0-only. Conventional commits. Semver: this release
  is `v0.2.0`.
- The npm `playwright` version is **exactly `1.63.0`**. It must equal nixos-unstable's
  `playwright-driver` (1.63.0, checked 2026-10-05; 26.05 ships 1.59.1, which does not match).
- Modules call only `just serve-at <port>` (and other `just` recipes) and read `kit.config.js`. No
  stack knowledge goes in `lib/`.
- `exe:firefox` screenshots use `--window-size=W` (width only). With `W,H`, FF115 captures only the
  viewport (checked 2026-10-05).
- Gating commands (`a11y`, `compat`, `smoke`) exit 1 on findings and 2 on usage or config errors.
  `shots` and `perf` exit 0 unless they cannot run.
- Style: tabs, single quotes, `node:` imports, comments say *why*, matching
  `bin/web-checks.js`. Mark deliberate ceilings with `// ponytail:`.
- Sonda: never touch `content/`; `just check` must be green before every sonda commit (see
  `AGENTS.md`).
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **`serve-at` missing, or the server dying on start:** expected a clear error naming the recipe
   within ~10s, not a hang. Tested in Task 1.
2. **Relative, fragment and query hrefs (`broken#top`, `/about?x=1`), and the crawl limit:**
   expected to resolve against the current page, dedupe by pathname, and stop at `limit`. Tested
   in Task 1.
3. **`compat.css` globs that match no files** (a renamed stylesheet): expected exit 2 ("matched
   nothing"), not a silent pass. Tested in Task 3.
4. **Proxy input it doesn't expect:** HTML without `<head>`, binary responses, an upstream that
   died. Expected: the beacon is prepended, binaries pass through byte-identical, and a dead
   upstream gives 502 recorded as a `proxy` error. Tested in Task 2.
5. **`exe:` engine paths given as `$VAR` when the variable is unset:** expected an error naming the
   variable, not spawning `""`. Tested in Task 5.

---

## File map (kit repo)

```
bin/kit.js                 dispatcher (replaces bin/web-checks.js)
lib/config.js              loadConfig(), enginesFor()
lib/site.js                freePort(), startSite(), crawl()
lib/proxy.js               BEACON, parseOff(), rewriteHtml(), blocked(), startProxy()
lib/engines.js             PLAYWRIGHT, CHROME_ARGS, parseEngine(), assertNative(), launch(), exeCmd(), exeLabel(), exeVisit(), exeScreenshot(), killProfile()
lib/cpu.js                 processes(), cpuPids(), cpuByKind(), sample(), frontmost(), machine()
lib/cmd/serve-dir.js       kit serve-dir DIR PORT
lib/cmd/a11y.js            kit a11y
lib/cmd/compat.js          kit compat
lib/cmd/smoke.js           kit smoke
lib/cmd/shots.js           kit shots
lib/cmd/perf.js            kit perf (+ exported variants(), summarise())
lib/cmd/install-browsers.js  kit install-browsers (macOS convenience)
test/run.js                kit() spawn helper
test/project/              fixture project: justfile, kit.config.js, site/
test/*.test.js
flake.nix, flake.lock
.github/workflows/test.yml
README.md
```

---

### Task 1: Dispatcher, config, site, and `a11y` ported onto them

**Files:**
- Create: `bin/kit.js`, `lib/config.js`, `lib/site.js`, `lib/cmd/serve-dir.js`, `lib/cmd/a11y.js`, `test/run.js`, `test/project/justfile`, `test/project/kit.config.js`, `test/project/site/{index.html,about/index.html,broken.html,404.html,style.css,ticker.js}`, `test/site.test.js`
- Delete: `bin/web-checks.js`; `test/site/` moves to `test/project/site/`
- Modify: `package.json`, `.gitignore`, `test/a11y.test.js` (rewritten)
- Test: `test/site.test.js`, `test/a11y.test.js`

**Interfaces:**
- Produces:
  - `loadConfig(dir = process.cwd()) → Promise<{pages:{start:string[],skip:string,limit:number}, engines:{ci:string[],local:string[]}, viewports:[number,number][], compat:{css:string[],targets:string,allow:string[]}, proxy:{block:string[]}, perf:{page:string,knobs:object}}>`
  - `enginesFor(config, override?: string) → string[]`
  - `freePort() → Promise<number>`
  - `startSite() → Promise<{origin:string, stop():void}>`
  - `crawl(origin, pages) → Promise<string[]>` (pathnames, in visit order)
  - `test/run.js`: `kit(args: string[], env?: object) → {code:number, out:string, err:string}`, run in `test/project`

- [ ] **Step 0: Branch**

```bash
cd ~/src/web-checks && git switch -c web-kit
```

- [ ] **Step 1: Move the fixture and write the fixture project**

```bash
git mv test/site test/project/site
```

`test/project/justfile`:
```
# The fixture project's half of the kit contract.
serve-at PORT:
    bun ../../bin/kit.js serve-dir site {{PORT}}
```

`test/project/kit.config.js`:
```js
export default {
	pages: { start: ['/', '/does-not-exist'] },
	engines: { ci: ['chromium'], local: ['chromium'] },
	viewports: [[390, 844], [1280, 800]],
	compat: { css: ['site/*.css'], targets: 'Firefox >= 115', allow: [] },
	proxy: { block: ['panel', 'api', '*.php'] },
	perf: {
		page: '/',
		knobs: {
			spin: { css: '.spin{animation:none!important}', probe: '.spin' },
			ticker: { script: 'ticker' },
		},
	},
};
```

`test/project/site/index.html`:
```html
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Home</title><link rel="stylesheet" href="/style.css"></head>
<body><main><h1>Home</h1><p class="spin">spinning</p>
<a href="/about">About</a> <a href="broken#top">Broken</a> <a href="/about?x=1">About again</a> <a href="https://example.com/">Away</a>
<script src="/ticker.js"></script></main></body></html>
```

`test/project/site/about/index.html` (one deliberate a11y violation: an image with no alt):
```html
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>About</title></head>
<body><main><h1>About</h1><img src="/style.css"><a href="/">Home</a></main></body></html>
```

`test/project/site/broken.html` (a runtime error and a missing image; axe-clean):
```html
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Broken</title></head>
<body><main><h1>Broken</h1><img src="/missing.png" alt=""><script>null.boom()</script></main></body></html>
```

`test/project/site/404.html`:
```html
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title></head>
<body><main><h1>Not found</h1><a href="/">Home</a></main></body></html>
```

`test/project/site/style.css` (`:has()` on line 3 is the planted compat finding for Task 3):
```css
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
main:has(.spin) { outline: 1px solid; }
```

`test/project/site/ticker.js`:
```js
setInterval(() => { document.title = String(Date.now()); }, 100);
```

Append to `.gitignore`:
```
.kit/
```

- [ ] **Step 2: Write the failing tests**

`test/run.js`:
```js
// Runs the kit CLI the way a project does: from the fixture project's root.
export const PROJECT = `${import.meta.dir}/project`;
export function kit(args, env = {}) {
	const r = Bun.spawnSync(['bun', `${import.meta.dir}/../bin/kit.js`, ...args], { cwd: PROJECT, env: { ...process.env, ...env } });
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
```

`test/site.test.js`:
```js
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.js';
import { crawl, startSite } from '../lib/site.js';
import { PROJECT } from './run.js';

const pages = {
	'/': '<a href="a">a</a> <a href="/b#x">b</a> <a href="/b?y=1">b again</a> <a href="/style.css">css</a> <a href="https://example.com/">away</a>',
	'/a': '<a href="/c">c</a>',
	'/b': '<a href="/d">d</a>',
};
const server = Bun.serve({
	port: 0,
	fetch: (req) => {
		const body = pages[new URL(req.url).pathname];
		return new Response(body ?? 'nope', { status: body ? 200 : 404, headers: { 'content-type': 'text/html' } });
	},
});
afterAll(() => server.stop(true));
const origin = `http://localhost:${server.port}`;

test('crawl resolves relative links, drops fragments, queries, files and other origins', async () => {
	expect(await crawl(origin, { start: ['/'], skip: '', limit: 80 })).toEqual(['/', '/a', '/b', '/c', '/d']);
});

test('crawl honours skip and limit', async () => {
	expect(await crawl(origin, { start: ['/'], skip: '^/a', limit: 80 })).toEqual(['/', '/b', '/d']);
	expect(await crawl(origin, { start: ['/'], skip: '', limit: 2 })).toEqual(['/', '/a']);
});

test('loadConfig fills defaults under the project file', async () => {
	const c = await loadConfig(PROJECT);
	expect(c.pages).toEqual({ start: ['/', '/does-not-exist'], skip: '', limit: 80 });
	expect(c.viewports).toEqual([[390, 844], [1280, 800]]);
	expect((await loadConfig(tmpdir())).engines.local).toEqual(['chromium']);
});

test('startSite fails fast and names the recipe when serve-at dies', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'kit-noserve-'));
	writeFileSync(join(dir, 'justfile'), 'serve-at PORT:\n    exit 1\n');
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		const t = Date.now();
		await expect(startSite()).rejects.toThrow(/just serve-at \d+/);
		expect(Date.now() - t).toBeLessThan(11_000);
	} finally {
		process.chdir(cwd);
	}
}, 15_000);
```

`test/a11y.test.js`:
```js
import { expect, test } from 'bun:test';
import { kit } from './run.js';

test('a11y crawls from the start paths and fails on the violation one link away', () => {
	const r = kit(['a11y']);
	expect(r.out).toContain('✗ /about — image-alt');
	expect(r.out).toContain('4 pages, 1 violation(s)');
	expect(r.code).toBe(1);
}, 60_000);

test('a11y --skip keeps the crawl on clean pages', () => {
	const r = kit(['a11y', '--skip', '^/about']);
	expect(r.out).toContain('3 pages, 0 violation(s)');
	expect(r.code).toBe(0);
}, 60_000);

test('unknown command prints usage and exits 2', () => {
	const r = kit(['nope']);
	expect(r.err).toContain('usage: kit <');
	expect(r.code).toBe(2);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test`
Expected: FAIL. `Cannot find module '../lib/config.js'` and `bin/kit.js` not found.

- [ ] **Step 4: Implement**

`bin/kit.js`:
```js
#!/usr/bin/env bun
// kit <command>: one file per command in lib/cmd/, each exporting run(args) → exit code.
const COMMANDS = ['a11y', 'compat', 'smoke', 'shots', 'perf', 'serve-dir', 'install-browsers'];
const [cmd, ...args] = process.argv.slice(2);
if (!COMMANDS.includes(cmd)) {
	console.error(`usage: kit <${COMMANDS.join('|')}> [options] — see the web-kit README`);
	process.exit(2);
}
const { run } = await import(`../lib/cmd/${cmd}.js`);
process.exit((await run(args)) ?? 0);
```

`lib/config.js`:
```js
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
```

`lib/site.js`:
```js
// The project's own server, through the contract's `just serve-at PORT`, and a
// crawl of it. Commands never know the stack; this file is why.
import { spawn } from 'node:child_process';

export async function freePort() {
	const probe = Bun.serve({ port: 0, fetch: () => new Response() });
	const { port } = probe;
	probe.stop(true);
	return port;
}

export async function startSite() {
	const port = await freePort();
	// detached: the recipe's shell is the group leader, so one kill takes the real server too.
	const child = spawn('just', ['serve-at', String(port)], { stdio: ['ignore', 'ignore', 'inherit'], detached: true });
	let exited = false;
	child.on('exit', () => (exited = true));
	child.on('error', () => (exited = true));
	const origin = `http://localhost:${port}`;
	const stop = () => {
		try {
			process.kill(-child.pid);
		} catch {}
	};
	for (let i = 0; ; i++) {
		if (await fetch(origin).then(() => true, () => false)) return { origin, stop };
		if (exited || i > 100) {
			stop();
			throw new Error(`\`just serve-at ${port}\` ${exited ? 'exited' : 'never answered'} on ${origin}`);
		}
		await Bun.sleep(100);
	}
}

// Every same-origin page reachable from pages.start, by pathname. Links come
// from the served HTML (HTMLRewriter), not a browser: crawling is the same for
// every engine, so it happens once.
export async function crawl(origin, { start, skip, limit }) {
	const skipRe = new RegExp(skip ? `${skip}|\\.\\w+$` : '\\.\\w+$');
	const queue = [...start];
	const seen = new Set(queue);
	for (const path of queue) {
		const res = await fetch(origin + path);
		if (!(res.headers.get('content-type') ?? '').includes('text/html')) continue;
		const hrefs = [];
		await new HTMLRewriter().on('a[href]', { element: (a) => void hrefs.push(a.getAttribute('href')) }).transform(res).text();
		for (const href of hrefs) {
			let url;
			try {
				url = new URL(href, origin + path);
			} catch {
				continue;
			}
			if (url.origin !== origin || skipRe.test(url.pathname) || seen.has(url.pathname) || seen.size >= limit) continue;
			seen.add(url.pathname);
			queue.push(url.pathname);
		}
	}
	return queue;
}
```

`lib/cmd/serve-dir.js` (the body is the old `serveDir`):
```js
// kit serve-dir DIR PORT: the static stack's serve-at. Static hosting the way
// Netlify/nginx do it: /x → x, x.html or x/index.html; else 404.html with 404.
import { statSync } from 'node:fs';
import { join } from 'node:path';

export async function run([dir, port]) {
	if (!dir || !port) {
		console.error('usage: kit serve-dir DIR PORT');
		return 2;
	}
	Bun.serve({
		port: Number(port),
		async fetch(req) {
			const p = join(dir, decodeURIComponent(new URL(req.url).pathname));
			for (const f of [p, `${p}.html`, join(p, 'index.html')]) {
				if (statSync(f, { throwIfNoEntry: false })?.isFile()) return new Response(Bun.file(f));
			}
			const notFound = Bun.file(join(dir, '404.html'));
			return new Response((await notFound.exists()) ? notFound : 'Not found', { status: 404, headers: { 'content-type': 'text/html' } });
		},
	});
	await new Promise(() => {}); // serve until killed
}
```

`lib/cmd/a11y.js`:
```js
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
	try {
		const paths = await crawl(site.origin, config.pages);
		// channel 'chromium': the full build in new-headless mode. nixpkgs' Linux browsers
		// ship it; the separate headless shell is not guaranteed there.
		const browser = await chromium.launch({ channel: 'chromium' });
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
		await browser.close();
		console.log(`${paths.length} pages, ${failed} violation(s)`);
	} finally {
		site.stop();
	}
	return failed ? 1 : 0;
}
```

`package.json`:
```json
{
  "name": "web-kit",
  "version": "0.2.0",
  "description": "Shared checks, stack shells and delivery scripts for web projects.",
  "license": "AGPL-3.0-only",
  "type": "module",
  "bin": { "kit": "bin/kit.js" },
  "files": ["bin", "lib"],
  "dependencies": { "axe-core": "^4.13.0", "playwright": "1.63.0" }
}
```

```bash
git rm bin/web-checks.js && bun install && bun x playwright install chromium
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor!: kit dispatcher; a11y reads kit.config.js and serves via just serve-at

BREAKING CHANGE: bin is now \`kit\`; --dir/--serve/--start/--limit move to kit.config.js and the
project's serve-at recipe. \`kit serve-dir DIR PORT\` replaces --dir.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The rewriting proxy (knobs, beacon, read-only guard)

**Files:**
- Create: `lib/proxy.js`, `test/proxy.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `BEACON: string` (an inline `<script>`)
  - `parseOff(value: string, knobs: object) → string[]` (accepts `'static'`, which means all knobs; throws on an unknown knob)
  - `rewriteHtml(html, {knobs={}, off=[], mouse=false, freeze=false, beacon=true, origin, self}) → string` (throws if a script knob's `<script>` is absent)
  - `blocked(pathname, block: string[]) → boolean`
  - `startProxy({origin, knobs={}, block=[], port=0, hostname='127.0.0.1'}) → {url, port, errors: {path,type,msg}[], responses: {path,status}[], stop()}`
  - URL params: `kit-off=a,b|static`, `kit-mouse`, `kit-freeze`. Beacon endpoint: `POST /__kit/beacon` with JSON `{path,type,msg}`, where `type` is one of `error|resource|rejection|console`. A dead upstream pushes `{type:'proxy'}`.

- [ ] **Step 1: Write the failing tests**

`test/proxy.test.js`:
```js
import { afterAll, expect, test } from 'bun:test';
import { BEACON, blocked, parseOff, rewriteHtml, startProxy } from '../lib/proxy.js';

const knobs = { spin: { css: '.spin{animation:none}', probe: '.spin' }, ticker: { script: 'ticker' } };
const PNG = new Uint8Array([137, 80, 78, 71, 0, 1, 2, 255]);
const upstream = Bun.serve({
	port: 0,
	fetch(req) {
		const { pathname } = new URL(req.url);
		if (pathname === '/headers') return Response.json([...req.headers.keys()]);
		if (pathname === '/img.png') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
		if (pathname === '/headless') return new Response('<p>no head</p>', { headers: { 'content-type': 'text/html' } });
		return new Response(`<html><head><title>x</title></head><body><a href="${origin}/a">a</a><script src="/ticker.js?v=1"></script></body></html>`, {
			headers: { 'content-type': 'text/html' },
		});
	},
});
const origin = `http://localhost:${upstream.port}`;
const proxy = startProxy({ origin, knobs, block: ['panel', 'api', '*.php'] });
afterAll(() => {
	proxy.stop();
	upstream.stop(true);
});
const get = (path, init) => fetch(proxy.url + path, init);

test('parseOff: static means every knob; unknown knobs throw', () => {
	expect(parseOff('static', knobs)).toEqual(['spin', 'ticker']);
	expect(parseOff('', knobs)).toEqual([]);
	expect(() => parseOff('nope', knobs)).toThrow('unknown knob "nope"');
});

test('rewriteHtml: beacon first in head, knob css, script removed, origin rewritten', () => {
	const html = `<html><head><title>x</title></head><body><a href="http://o/a">a</a><script src="/ticker.js"></script></body></html>`;
	const out = rewriteHtml(html, { knobs, off: ['spin', 'ticker'], origin: 'http://o', self: 'http://p' });
	expect(out.indexOf(BEACON)).toBe(out.indexOf('<head>') + '<head>'.length);
	expect(out).toContain('<style data-kit>.spin{animation:none}</style></head>');
	expect(out).not.toContain('ticker.js');
	expect(out).toContain('href="http://p/a"');
	expect(() => rewriteHtml('<head></head>', { knobs, off: ['ticker'] })).toThrow('no <script> for ticker.js');
});

test('rewriteHtml: no <head> means the beacon is prepended', () => {
	expect(rewriteHtml('<p>x</p>', {}).startsWith(BEACON)).toBe(true);
});

test('blocked: any decoded, case-folded segment; *.php suffix', () => {
	for (const p of ['/panel', '/PANEL/x', '/%70anel', '/index.php/panel', '/api/x', '/x.php', '/%zz']) expect(blocked(p, ['panel', 'api', '*.php'])).toBe(true);
	for (const p of ['/', '/panelist', '/about']) expect(blocked(p, ['panel', 'api', '*.php'])).toBe(false);
});

test('proxy: read-only and blocked paths get 403', async () => {
	expect((await get('/panel')).status).toBe(403);
	expect((await get('/%70anel')).status).toBe(403);
	expect((await get('/index.php/panel')).status).toBe(403);
	expect((await get('/', { method: 'POST' })).status).toBe(403);
});

test('proxy: strips method-override headers', async () => {
	const names = await (await get('/headers', { headers: { 'X-HTTP-Method-Override': 'POST', 'X-Method-Override': 'PUT' } })).json();
	expect(names.some((n) => /method-override/i.test(n))).toBe(false);
});

test('proxy: rewrites HTML, passes binaries through byte-identical', async () => {
	const html = await (await get('/?kit-off=spin')).text();
	expect(html).toContain(BEACON);
	expect(html).toContain('.spin{animation:none}');
	expect(html).toContain(`href="${proxy.url}/a"`);
	expect(new Uint8Array(await (await get('/img.png')).arrayBuffer())).toEqual(PNG);
	expect((await (await get('/headless')).text()).startsWith(BEACON)).toBe(true);
	expect((await get('/?kit-off=nope')).status).toBe(400);
	expect(proxy.responses.some((r) => r.path === '/img.png' && r.status === 200)).toBe(true);
});

test('proxy: kit-freeze stops animations; kit-mouse adds the synthetic pointer', async () => {
	const html = await (await get('/?kit-freeze&kit-mouse')).text();
	expect(html).toContain('animation:none!important');
	expect(html).toContain("new MouseEvent('mousemove'");
});

test('proxy: beacon POSTs are recorded', async () => {
	proxy.errors.length = 0;
	expect((await get('/__kit/beacon', { method: 'POST', body: JSON.stringify({ path: '/x', type: 'error', msg: 'boom' }) })).status).toBe(204);
	expect(proxy.errors).toEqual([{ path: '/x', type: 'error', msg: 'boom' }]);
});

test('proxy: a dead upstream gives 502 and a proxy error', async () => {
	const dead = startProxy({ origin: 'http://127.0.0.1:9' });
	expect((await fetch(dead.url + '/')).status).toBe(502);
	expect(dead.errors[0].type).toBe('proxy');
	dead.stop();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/proxy.test.js`
Expected: FAIL with `Cannot find module '../lib/proxy.js'`.

- [ ] **Step 3: Implement `lib/proxy.js`**

```js
// The rewriting proxy every browser-facing command goes through. Each variant
// is a URL, which is what lets a browser the kit cannot drive (FF115, a phone
// on the LAN) take part:
//   ?kit-off=a,b|static   perf knobs off (kit.config.js perf.knobs)
//   ?kit-mouse            synthetic pointer, for browsers with no driver
//   ?kit-freeze           every animation and transition off, for screenshots
// Every HTML page also gets BEACON first in <head>: runtime errors POST back
// to /__kit/beacon, so any browser reports them.

// ES5 on purpose: it has to run in the oldest engine anyone points at it.
export const BEACON =
	"<script>(function(){function s(t,m){try{var x=new XMLHttpRequest();x.open('POST','/__kit/beacon',true);x.send(JSON.stringify({path:location.pathname,type:t,msg:String(m)}))}catch(e){}}" +
	"addEventListener('error',function(e){var t=e.target;if(t&&t!==window){s('resource',t.src||t.href||t.tagName)}else{s('error',e.message)}},true);" +
	"addEventListener('unhandledrejection',function(e){s('rejection',e.reason&&e.reason.message||e.reason)});" +
	"var c=console.error;console.error=function(){s('console',[].join.call(arguments,' '));return c.apply(console,arguments)}})()</script>";

const FREEZE = '*,*::before,*::after{animation:none!important;transition:none!important}';
const FAKE_MOUSE =
	"<script>setInterval(function(){window.dispatchEvent(new MouseEvent('mousemove',{clientX:innerWidth*Math.random(),clientY:innerHeight*Math.random(),movementX:20,movementY:20}))},16)</script>";

export function parseOff(value, knobs) {
	if (value === 'static') return Object.keys(knobs);
	const off = value ? value.split(',').filter(Boolean) : [];
	for (const name of off) {
		if (!knobs[name]) throw new Error(`unknown knob "${name}" — known: ${Object.keys(knobs).join(', ')}`);
	}
	return off;
}

export function rewriteHtml(html, { knobs = {}, off = [], mouse = false, freeze = false, beacon = true, origin, self }) {
	let out = origin && self ? html.replaceAll(origin, self) : html;
	if (beacon) out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (head) => head + BEACON) : BEACON + out;
	for (const name of off) {
		const { script } = knobs[name];
		if (!script) continue;
		const re = new RegExp(`<script[^>]*src="[^"]*/${script}\\.js[^"]*"[^>]*></script>`);
		if (!re.test(out)) throw new Error(`knob "${name}": no <script> for ${script}.js on this page`);
		out = out.replace(re, '');
	}
	const css = off.map((name) => knobs[name].css).filter(Boolean).join('') + (freeze ? FREEZE : '');
	if (css) out = out.replace('</head>', `<style data-kit>${css}</style></head>`);
	if (mouse) out = out.replace('</body>', FAKE_MOUSE + '</body>');
	return out;
}

// Any segment, decoded and case-folded: /PANEL, /%70anel and /index.php/panel
// all reach a Kirby Panel. Undecodable paths are blocked outright.
export function blocked(pathname, block) {
	let segments;
	try {
		segments = decodeURIComponent(pathname).toLowerCase().split('/');
	} catch {
		return true;
	}
	return segments.some((s) => block.some((b) => (b.startsWith('*') ? s.endsWith(b.slice(1)) : s === b)));
}

export function startProxy({ origin, knobs = {}, block = [], port = 0, hostname = '127.0.0.1' }) {
	const errors = [];
	const responses = [];
	const server = Bun.serve({
		port,
		hostname,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === '/__kit/beacon' && req.method === 'POST') {
				try {
					errors.push(JSON.parse(await req.text()));
				} catch {}
				return new Response(null, { status: 204 });
			}
			// The proxy may face the LAN (perf --serve), and dev servers often trust
			// localhost: pages only, read-only.
			if (!['GET', 'HEAD'].includes(req.method) || blocked(url.pathname, block)) {
				return new Response('kit proxy: read-only, blocked path', { status: 403 });
			}
			let off;
			try {
				off = parseOff(url.searchParams.get('kit-off') ?? '', knobs);
			} catch (e) {
				return new Response(e.message, { status: 400 });
			}
			const mouse = url.searchParams.has('kit-mouse');
			const freeze = url.searchParams.has('kit-freeze');
			for (const p of ['kit-off', 'kit-mouse', 'kit-freeze']) url.searchParams.delete(p);
			const headers = new Headers(req.headers);
			headers.delete('accept-encoding');
			// Kirby (and others) honour X-HTTP-Method-Override: a GET could act as a POST.
			for (const name of [...headers.keys()]) if (/method-override/i.test(name)) headers.delete(name);
			let res;
			try {
				res = await fetch(origin + url.pathname + url.search, { method: req.method, headers, redirect: 'manual' });
			} catch (e) {
				errors.push({ path: url.pathname, type: 'proxy', msg: `${origin} unreachable: ${e.message}` });
				return new Response(`kit proxy: ${origin} unreachable`, { status: 502 });
			}
			responses.push({ path: url.pathname, status: res.status });
			if (!(res.headers.get('content-type') ?? '').includes('text/html')) return res;
			let html;
			try {
				html = rewriteHtml(await res.text(), { knobs, off, mouse, freeze, origin, self: url.origin });
			} catch (e) {
				return new Response(e.message, { status: 400 });
			}
			const out = new Headers(res.headers);
			out.delete('content-length');
			out.delete('content-encoding');
			return new Response(html, { status: res.status, headers: out });
		},
	});
	return { url: `http://${hostname === '0.0.0.0' ? '127.0.0.1' : hostname}:${server.port}`, port: server.port, errors, responses, stop: () => server.stop(true) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/proxy.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/proxy.js test/proxy.test.js && git commit -m "feat(proxy): rewriting proxy with knobs, error beacon and read-only guard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `kit compat`

**Files:**
- Create: `lib/cmd/compat.js`, `test/compat.test.js`
- Modify: `package.json` (add `doiuse`, `postcss`)

**Interfaces:**
- Consumes: `loadConfig()` (Task 1).
- Produces: `kit compat` prints one `✗ <file>:<line> — <message>` line per finding and a summary
  line `<n> file(s), <m> unsupported feature use(s) for "<targets>"`. It exits 1 on any finding, and
  2 when there are no globs or the globs match no files.

- [ ] **Step 1: Add the dependencies**

```bash
bun add doiuse@^6.0.6 postcss@^8
```

- [ ] **Step 2: Write the failing tests**

`test/compat.test.js`:
```js
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kit } from './run.js';

const KIT = join(import.meta.dir, '..', 'bin', 'kit.js');
const inDir = (config) => {
	const dir = mkdtempSync(join(tmpdir(), 'kit-compat-'));
	writeFileSync(join(dir, 'a.css'), 'main:has(.x) { color: red; }\n');
	writeFileSync(join(dir, 'kit.config.js'), `export default ${JSON.stringify({ compat: config })};`);
	const r = Bun.spawnSync(['bun', KIT, 'compat'], { cwd: dir });
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

test('reports the planted :has() against Firefox 115 with file and line', () => {
	const r = kit(['compat']);
	expect(r.out).toContain('✗ site/style.css:3 — ');
	expect(r.out).toContain('(css-has)');
	expect(r.out).toContain('1 file(s), 1 unsupported feature use(s) for "Firefox >= 115"');
	expect(r.code).toBe(1);
});

test('allow suppresses a deliberate feature', () => {
	const r = inDir({ css: ['*.css'], targets: 'Firefox >= 115', allow: ['css-has'] });
	expect(r.out).toContain('0 unsupported');
	expect(r.code).toBe(0);
});

test('globs that match nothing are a config error, not a pass', () => {
	const r = inDir({ css: ['nope/*.css'], targets: 'Firefox >= 115' });
	expect(r.err).toContain('matched no files');
	expect(r.code).toBe(2);
});

test('no globs configured is a config error', () => {
	const r = inDir({});
	expect(r.err).toContain('compat.css');
	expect(r.code).toBe(2);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test test/compat.test.js`
Expected: FAIL. The dispatcher throws `Cannot find module '../lib/cmd/compat.js'`.

- [ ] **Step 4: Implement `lib/cmd/compat.js`**

```js
// kit compat: shipped CSS against the project's browser targets (caniuse data
// through doiuse). Static and fast; it says nothing about JS — `kit smoke` in
// old engines covers that. Progressive enhancement inside @supports is still
// reported: list those feature ids in compat.allow.
import { Glob } from 'bun';
import { parseArgs } from 'node:util';
import doiuse from 'doiuse';
import postcss from 'postcss';
import { loadConfig } from '../config.js';

export async function run(args) {
	parseArgs({ args, options: {} });
	const { compat } = await loadConfig();
	if (!compat.css.length) {
		console.error('kit compat: set compat.css (globs of shipped stylesheets) in kit.config.js');
		return 2;
	}
	const files = [];
	for (const pattern of compat.css) for await (const file of new Glob(pattern).scan('.')) files.push(file);
	if (!files.length) {
		console.error(`kit compat: compat.css ${JSON.stringify(compat.css)} matched no files`);
		return 2;
	}
	let found = 0;
	for (const file of files.sort()) {
		const report = (usage) => {
			found++;
			// doiuse prefixes "<abs path>:<line>:<col>: "; keep only the message.
			console.log(`✗ ${file}:${usage.usage.source.start.line} — ${usage.message.split(': ').slice(1).join(': ')}`);
		};
		await postcss([doiuse({ browsers: compat.targets, ignore: compat.allow, onFeatureUsage: report })]).process(await Bun.file(file).text(), { from: file });
	}
	console.log(`${files.length} file(s), ${found} unsupported feature use(s) for "${compat.targets}"`);
	return found ? 1 : 0;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/compat.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(compat): kit compat audits shipped CSS against browser targets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Engines (Playwright) and `kit smoke`

**Files:**
- Create: `lib/engines.js`, `lib/cmd/smoke.js`, `test/smoke.test.js`, `test/engines.test.js`

**Interfaces:**
- Consumes: `loadConfig`, `enginesFor` (Task 1); `startSite`, `crawl` (Task 1); `startProxy` (Task 2).
- Produces (`lib/engines.js`):
  - `PLAYWRIGHT: {chrome, chromium, firefox, webkit}`, each `[browserType, launchOptions]`
  - `CHROME_ARGS: string[]` (the Metal flags; used by perf)
  - `parseEngine(spec) → {kind:'playwright', name} | {kind:'exe', flavour:'firefox'|'chrome', path, name}` (`name` is the original spec)
  - `assertNative()` throws under Rosetta
  - `launch(name) → Promise<Browser>` (headless)
  - Task 5 adds `exeCmd`, `exeLabel`, `exeVisit`, `exeScreenshot`, `killProfile`.
- Produces (smoke): output lines `✗ <engine> <path> — <reason>` and the summary
  `<pages> pages × <engines> engine(s), <n> error(s)`.

- [ ] **Step 1: Write the failing tests**

`test/engines.test.js`:
```js
import { expect, test } from 'bun:test';
import { parseEngine } from '../lib/engines.js';

test('parseEngine: playwright names and exe specs', () => {
	expect(parseEngine('webkit')).toEqual({ kind: 'playwright', name: 'webkit' });
	expect(parseEngine('exe:firefox:/opt/ff/firefox')).toEqual({ kind: 'exe', flavour: 'firefox', path: '/opt/ff/firefox', name: 'exe:firefox:/opt/ff/firefox' });
	expect(() => parseEngine('opera')).toThrow('unknown engine "opera"');
	expect(() => parseEngine('exe:safari:/x')).toThrow('exe:firefox:<path> or exe:chrome:<path>');
});
```

`test/smoke.test.js`:
```js
import { expect, test } from 'bun:test';
import { kit } from './run.js';

test('smoke fails on the runtime error and the missing image, not on the 404 start path', () => {
	const r = kit(['smoke']);
	expect(r.out).toMatch(/✗ chromium \/broken — pageerror: .*boom/);
	expect(r.out).toContain('✗ chromium /broken — 404 /missing.png');
	expect(r.out).not.toContain('/does-not-exist —');
	expect(r.out).not.toContain('Failed to load resource');
	expect(r.out).toContain('4 pages × 1 engine(s), 2 error(s)');
	expect(r.code).toBe(1);
}, 60_000);

test('smoke passes once the broken page is skipped', () => {
	const r = kit(['smoke', '--skip', '^/broken']);
	expect(r.out).toContain('3 pages × 1 engine(s), 0 error(s)');
	expect(r.code).toBe(0);
}, 60_000);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/engines.test.js test/smoke.test.js`
Expected: FAIL with `Cannot find module '../lib/engines.js'`.

- [ ] **Step 3: Implement `lib/engines.js`**

```js
// Browsers. Two kinds:
//   playwright:  chrome (branded), chromium, firefox, webkit
//   exe:<firefox|chrome>:<path>  a binary Playwright cannot drive (FF115);
//                path may be $VAR (the kit dev shell exports KIT_FIREFOX_115)
// Lessons from sonda-web's perf runs live here so every command inherits them.
import { spawnSync } from 'node:child_process';
import { chromium, firefox, webkit } from 'playwright';

export const PLAYWRIGHT = {
	chrome: [chromium, { channel: 'chrome' }],
	// The full build in new-headless mode: nixpkgs' Linux browsers ship it,
	// the separate headless shell is not guaranteed there.
	chromium: [chromium, { channel: 'chromium' }],
	firefox: [firefox, {}],
	webkit: [webkit, {}],
};

// Without these Playwright runs branded Chrome on SwiftShader (software GL):
// an animation costs ~2 cores that hardware-composited Chrome never spends.
// Checked 2026-10-04 by reading the WebGL renderer string in the measured page.
export const CHROME_ARGS = [
	'--disable-backgrounding-occluded-windows',
	'--disable-renderer-backgrounding',
	'--no-first-run',
	'--no-default-browser-check',
	'--use-angle=metal',
	'--disable-features=UnsafeSwiftShader',
];

export function parseEngine(spec) {
	if (spec.startsWith('exe:')) {
		const [, flavour, ...rest] = spec.split(':');
		const path = rest.join(':');
		if (!['firefox', 'chrome'].includes(flavour) || !path) throw new Error(`engine "${spec}": expected exe:firefox:<path> or exe:chrome:<path>`);
		return { kind: 'exe', flavour, path, name: spec };
	}
	if (!PLAYWRIGHT[spec]) throw new Error(`unknown engine "${spec}" — ${Object.keys(PLAYWRIGHT).join(', ')}, or exe:<firefox|chrome>:<path>`);
	return { kind: 'playwright', name: spec };
}

// An x86 parent makes a universal browser launch translated: every timing and
// CPU number is garbage.
export function assertNative() {
	if (process.platform !== 'darwin') return;
	const translated = spawnSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' }).stdout.trim();
	if (translated === '1') throw new Error('running under Rosetta — browsers would launch translated. Use a native bun.');
}

export function launch(name) {
	const [type, opts] = PLAYWRIGHT[name];
	return type.launch(opts);
}
```

- [ ] **Step 4: Implement `lib/cmd/smoke.js` (Playwright engines; Task 5 adds `exe:`)**

```js
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
	for (const path of paths) {
		const page = await browser.newPage();
		const own = (u) => u.startsWith(base);
		page.on('pageerror', (e) => fail(name, path, `pageerror: ${e.message}`));
		// The browser's own "Failed to load resource" lines duplicate the response check below.
		page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && fail(name, path, `console.error: ${m.text()}`));
		page.on('requestfailed', (r) => own(r.url()) && fail(name, path, `request failed: ${pathOf(r.url())} (${r.failure()?.errorText})`));
		page.on('response', (r) => {
			// Browsers fetch /favicon.ico unasked; a site without one is not broken.
			if (!own(r.url()) || pathOf(r.url()) === '/favicon.ico') return;
			const doc = pathOf(r.url()) === path;
			if (r.status() >= (doc ? 500 : 400)) fail(name, path, `${r.status()} ${pathOf(r.url())}`);
		});
		await page.goto(base + path, { waitUntil: 'load' });
		await page.waitForTimeout(500); // ponytail: fixed settle; errors after this are missed
		await page.close();
	}
	await browser.close();
}

async function smokeExe() {
	throw new Error('exe engines: Task 5');
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/engines.test.js test/smoke.test.js`
Expected: PASS (3 tests). If the `pageerror` text differs, keep the regex anchored on `boom`; the
message wording varies by Chromium version.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(smoke): kit smoke fails on runtime errors and broken requests per engine

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `exe:` engines, smoke through the beacon

**Files:**
- Modify: `lib/engines.js` (append), `lib/cmd/smoke.js` (replace `smokeExe`), `test/engines.test.js`, `test/smoke.test.js`

**Interfaces:**
- Consumes: `parseEngine` (Task 4); `startProxy().errors/.responses` (Task 2).
- Produces:
  - `exeCmd(engine, args) → [cmd, args]` (on Apple Silicon, `arch -arm64` so a universal binary
    never runs translated)
  - `exeLabel(engine) → string` (`<basename> <--version output>`)
  - `killProfile(profile)`
  - `exeVisit(engine, url, seconds = 3) → Promise<void>`
  - `exeScreenshot(engine, url, [width, height], out, fullHeight?) → boolean`
  - `parseEngine` now expands a `$VAR` path and throws `engine "<spec>": $VAR is not set` when it's
    missing.

- [ ] **Step 1: Write the failing tests**

Append to `test/engines.test.js`:
```js
test('parseEngine expands $VAR paths and names a missing one', () => {
	process.env.KIT_TEST_FF = '/opt/ff/firefox';
	expect(parseEngine('exe:firefox:$KIT_TEST_FF').path).toBe('/opt/ff/firefox');
	delete process.env.KIT_TEST_FF;
	expect(() => parseEngine('exe:firefox:$KIT_TEST_FF')).toThrow('$KIT_TEST_FF is not set');
});
```

Append to `test/smoke.test.js`. Playwright's own Chromium binary stands in for an old browser: it
is driven only through its command line, exactly like FF115.
```js
import { chromium } from 'playwright';

test('exe engines report through the beacon and the proxy', () => {
	const r = kit(['smoke', '--engines', 'exe:chrome:$KIT_TEST_CHROME'], { KIT_TEST_CHROME: chromium.executablePath() });
	expect(r.out).toMatch(/✗ exe:chrome:\$KIT_TEST_CHROME \/broken — error: .*boom/);
	expect(r.out).toContain('✗ exe:chrome:$KIT_TEST_CHROME /broken — 404 /missing.png');
	expect(r.out).not.toContain('/does-not-exist —');
	expect(r.code).toBe(1);
}, 120_000);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/engines.test.js test/smoke.test.js`
Expected: FAIL. The `$VAR` path is returned unexpanded, and smoke throws `exe engines: Task 5`.

- [ ] **Step 3: Implement**

In `lib/engines.js`, change the `exe:` branch of `parseEngine` to expand the path:
```js
	if (spec.startsWith('exe:')) {
		const [, flavour, ...rest] = spec.split(':');
		let path = rest.join(':');
		if (!['firefox', 'chrome'].includes(flavour) || !path) throw new Error(`engine "${spec}": expected exe:firefox:<path> or exe:chrome:<path>`);
		if (path.startsWith('$')) {
			const value = process.env[path.slice(1)];
			if (!value) throw new Error(`engine "${spec}": ${path} is not set`);
			path = value;
		}
		return { kind: 'exe', flavour, path, name: spec };
	}
```

Change the imports at the top of `lib/engines.js` to:
```js
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
```

Append to `lib/engines.js`:
```js
// ---------- exe: engines, driven only by their command line ----------

export function exeCmd(engine, args) {
	return process.platform === 'darwin' && process.arch === 'arm64' ? ['arch', ['-arm64', engine.path, ...args]] : [engine.path, args];
}

export function exeLabel(engine) {
	const [cmd, args] = exeCmd(engine, ['--version']);
	return `${basename(engine.path)} ${spawnSync(cmd, args, { encoding: 'utf8' }).stdout.trim()}`;
}

// Throwaway profile per launch; its path is on the browser's command line,
// which is how every process of that launch is found and killed (Firefox
// relaunches itself, so its PID is no handle).
function profileArgs(engine) {
	const profile = mkdtempSync(join(tmpdir(), 'kit-exe-'));
	const args =
		engine.flavour === 'firefox'
			? ['--headless', '--no-remote', '--profile', profile]
			: ['--headless', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`];
	return { profile, args };
}

export function killProfile(profile) {
	spawnSync('pkill', ['-f', profile]);
	Bun.sleepSync(500);
	spawnSync('pkill', ['-9', '-f', profile]);
}

// Load a page and leave it running long enough for the beacon to report.
export async function exeVisit(engine, url, seconds = 3) {
	const { profile, args } = profileArgs(engine);
	const [cmd, argv] = exeCmd(engine, [...args, url]);
	spawn(cmd, argv, { stdio: 'ignore' });
	await Bun.sleep((seconds + 2) * 1000); // ponytail: fixed launch + settle time
	killProfile(profile);
}

// The binary's own headless screenshot. Firefox: width-only --window-size
// captures the full page (W,H captures just the viewport; checked on FF115,
// 2026-10-05). Chrome's capture is the window, so it gets the page height
// measured elsewhere.
export function exeScreenshot(engine, url, [width, height], out, fullHeight) {
	const { profile, args } = profileArgs(engine);
	const shot =
		engine.flavour === 'firefox'
			? [`--window-size=${width}`, '--screenshot', out]
			: [`--window-size=${width},${fullHeight ?? height}`, '--hide-scrollbars', `--screenshot=${out}`];
	const [cmd, argv] = exeCmd(engine, [...args, ...shot, url]);
	spawnSync(cmd, argv, { stdio: 'ignore', timeout: 60_000 });
	killProfile(profile);
	return Bun.file(out).size > 0;
}
```

Replace `smokeExe` in `lib/cmd/smoke.js` and add `exeVisit` to its engines import
(`import { exeVisit, launch, parseEngine } from '../engines.js';`):
```js
// Old binaries have no driver: the proxy is the instrument. The beacon reports
// script errors; the proxy's own log reports broken same-origin requests.
async function smokeExe(engine, paths, proxy, fail) {
	for (const path of paths) {
		proxy.errors.length = 0;
		proxy.responses.length = 0;
		await exeVisit(engine, proxy.url + path);
		for (const e of proxy.errors) if (e.type !== 'resource') fail(engine.name, path, `${e.type}: ${e.msg}`);
		for (const r of proxy.responses) if (r.path !== '/favicon.ico' && r.status >= (r.path === path ? 500 : 400)) fail(engine.name, path, `${r.status} ${r.path}`);
	}
}
```

Resource errors from the beacon are skipped because the proxy log already reports the same failed
request with its status.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/engines.test.js test/smoke.test.js`
Expected: PASS (5 tests). If the exe test sees no beacon error, raise `exeVisit`'s seconds to 5
before suspecting the beacon. Cold Chromium launches are slow on CI.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(smoke): exe: engines report through the proxy beacon

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `kit shots` contact sheet

**Files:**
- Create: `lib/cmd/shots.js`, `test/shots.test.js`

**Interfaces:**
- Consumes: `loadConfig`, `enginesFor`, `startSite`, `crawl`, `startProxy` (`kit-freeze`, `.errors`), `launch`, `parseEngine`, `exeLabel`, `exeScreenshot`.
- Produces: `.kit/shots/<YYYY-MM-DDTHHMM>-<sha>/index.html`, plus one PNG per engine × viewport ×
  page. It prints `sheet: <absolute path>` and exits 0.

- [ ] **Step 1: Write the failing test**

`test/shots.test.js`:
```js
import { afterAll, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { kit, PROJECT } from './run.js';

afterAll(() => rmSync(join(PROJECT, '.kit'), { recursive: true, force: true }));

test('shots writes a sheet: pages × (engine × viewport), exe engines included', () => {
	const r = kit(['shots', '--engines', 'chromium,exe:chrome:$KIT_TEST_CHROME'], { KIT_TEST_CHROME: chromium.executablePath() });
	expect(r.code).toBe(0);
	const sheet = r.out.match(/sheet: (.+)/)[1].trim();
	const html = readFileSync(sheet, 'utf8');
	expect(html.match(/<tr data-path=/g)).toHaveLength(4);
	expect(html.match(/<th data-col=/g)).toHaveLength(4);
	const pngs = readdirSync(dirname(sheet)).filter((f) => f.endsWith('.png'));
	expect(pngs).toHaveLength(16);
	expect(html).toMatch(/boom/); // the beacon / pageerror note under /broken
	expect(existsSync(join(PROJECT, '.kit', 'shots'))).toBe(true);
}, 300_000);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/shots.test.js`
Expected: FAIL with `Cannot find module '../lib/cmd/shots.js'`.

- [ ] **Step 3: Implement `lib/cmd/shots.js`**

```js
// kit shots: a contact sheet for eyeballing layout across engines and viewports.
// Rows are pages; columns are engine × viewport; any error the page reported is
// noted under its cell. Report only — it never fails the build.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { enginesFor, loadConfig } from '../config.js';
import { exeLabel, exeScreenshot, launch, parseEngine } from '../engines.js';
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
	const dir = resolve('.kit', 'shots', `${new Date().toISOString().slice(0, 16).replace(/:/g, '')}-${sha}`);
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
			for (const [w, h] of config.viewports) {
				const col = `${slug(label)}-${w}x${h}`;
				cols.push({ id: col, label: `${label} · ${w}×${h}` });
				const ctx = browser && (await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' }));
				for (const path of paths) {
					const file = `${col}-${slug(path)}.png`;
					const notes = [];
					const url = `${proxy.url}${path}${path.includes('?') ? '&' : '?'}kit-freeze`;
					if (ctx) {
						const page = await ctx.newPage();
						page.on('pageerror', (e) => notes.push(`pageerror: ${e.message}`));
						await page.goto(url, { waitUntil: 'load' });
						if (!heights.has(`${w}|${path}`)) heights.set(`${w}|${path}`, await page.evaluate(() => document.documentElement.scrollHeight));
						await page.screenshot({ path: join(dir, file), fullPage: true, animations: 'disabled' });
						await page.close();
					} else {
						proxy.errors.length = 0;
						if (!exeScreenshot(engine, url, [w, h], join(dir, file), heights.get(`${w}|${path}`))) notes.push('no screenshot (binary failed or timed out)');
						for (const e of proxy.errors) notes.push(`${e.type}: ${e.msg}`);
					}
					cells.set(`${col}|${path}`, { file, notes });
				}
				await ctx?.close();
			}
			await browser?.close();
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
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>kit shots ${esc(sha)}</title>
<style>body{font:13px system-ui;margin:1rem}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:4px;vertical-align:top}
td img{width:220px;display:block}th[scope=row]{position:sticky;left:0;background:#fff}thead th{position:sticky;top:0;background:#fff}ul{color:#b00;margin:4px 0;padding-left:1rem;max-width:220px}</style>
</head><body><table><thead><tr><th></th>${head}</tr></thead><tbody>
${rows}
</tbody></table></body></html>`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/shots.test.js`
Expected: PASS. Open the printed sheet once and check by eye that the exe column's full-page
screenshots are not cropped.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(shots): contact sheet across engines and viewports, exe binaries included

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `kit perf` (port of sonda's runner) and `cpu.js`

**Files:**
- Create: `lib/cpu.js`, `lib/cmd/perf.js`, `lib/cmd/install-browsers.js`, `test/perf.test.js`
- Source: `~/src/sonda-web/perf/run.js` (functions `processes`, `cpuPids`, `cpuByKind`, `frontmost`, `sample`, `playwrightBrowser`, `exeBrowser`, `baselineDelta`, `machine`, the matrix loop)

**Interfaces:**
- Consumes: `loadConfig`, `enginesFor`, `startSite`, `startProxy` (`kit-off`, `kit-mouse`, `.errors`), `PLAYWRIGHT`, `CHROME_ARGS`, `parseEngine`, `assertNative`, `exeCmd`, `exeLabel`, `killProfile`.
- Produces:
  - `variants(knobs, off?: string[]) → {name, off: string[], isStatic: boolean}[]`. The default is
    static, shipped, then each knob.
  - `summarise(totals: number[]) → {median, min, max}`
  - CLI: `kit perf [--engines] [--page] [--off a,b]… [--inputs idle,mouse] [--repeat 2] [--warm 6] [--measure 10] [--origin URL] [--serve [--port 8799]] [--save-baseline]`
  - Writes `.kit/perf/<stamp>-<sha>.json`; the baseline is `perf-baseline.json` in the project root.

- [ ] **Step 1: Write the failing tests**

`test/perf.test.js`:
```js
import { expect, test } from 'bun:test';
import { summarise, variants } from '../lib/cmd/perf.js';
import { kit } from './run.js';

const knobs = { spin: { css: 'x' }, ticker: { script: 'ticker' } };

test('variants: static floor, shipped, then each knob; --off lists override', () => {
	expect(variants(knobs).map((v) => v.name)).toEqual(['static', 'shipped', '-spin', '-ticker']);
	expect(variants(knobs, ['spin,ticker'])).toEqual([{ name: '-spin,-ticker', off: ['spin', 'ticker'], isStatic: false }]);
	expect(() => variants(knobs, ['nope'])).toThrow('unknown knob');
});

test('summarise: median and spread', () => {
	expect(summarise([30, 10, 20])).toEqual({ median: 20, min: 10, max: 30 });
	expect(summarise([5])).toEqual({ median: 5, min: 5, max: 5 });
});

test.skipIf(process.platform === 'darwin')('perf refuses to run off macOS', () => {
	const r = kit(['perf']);
	expect(r.err).toContain('macOS only');
	expect(r.code).toBe(2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/perf.test.js`
Expected: FAIL with `Cannot find module '../lib/cmd/perf.js'`.

- [ ] **Step 3: Implement `lib/cpu.js`**

```js
// CPU of a whole browser (GPU and content processes included), from `ps`.
// macOS only. Checked 2026-10-04: two busy loops read ~100% of one core each
// over 5s, matching `top -l`.
import { spawnSync } from 'node:child_process';

const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).stdout.trim();

export function processes() {
	return sh('ps', ['-axo', 'pid=,ppid=,cputime=,command=']).split('\n').map((line) => {
		const [pid, ppid, time, ...cmd] = line.trim().split(/\s+/);
		const secs = time.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
		return { pid: +pid, ppid: +ppid, secs, cmd: cmd.join(' ') };
	});
}

export function cpuPids(marker) {
	return processes().filter((p) => p.cmd.includes(marker)).map((p) => p.pid);
}

// Firefox and Chrome composite in a GPU process; WebKit's helpers are XPC
// services, not children — they are found by marker, not by parentage.
export function cpuByKind(rootPids, markers) {
	const procs = processes();
	const kids = new Map();
	for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
	const stack = procs.filter((p) => rootPids.includes(p.pid) || markers.some((m) => m && p.cmd.includes(m)));
	const seen = new Set();
	const kinds = {};
	while (stack.length) {
		const p = stack.pop();
		if (seen.has(p.pid)) continue;
		seen.add(p.pid);
		const kind = /GPU/i.test(p.cmd) ? 'gpu' : rootPids.includes(p.pid) ? 'browser' : 'other';
		kinds[kind] = (kinds[kind] ?? 0) + p.secs;
		stack.push(...(kids.get(p.pid) ?? []));
	}
	return kinds;
}

// macOS stops compositing occluded windows: a background window reads near zero.
export function frontmost(pid) {
	sh('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`]);
}

export async function sample(pids, markers, seconds) {
	const a = cpuByKind(pids, markers);
	await Bun.sleep(seconds * 1000);
	const b = cpuByKind(pids, markers);
	const pct = (k) => (100 * ((b[k] ?? 0) - (a[k] ?? 0))) / seconds;
	return { total: Object.keys(b).reduce((s, k) => s + pct(k), 0), gpu: pct('gpu') };
}

export function machine() {
	return sh('sysctl', ['-n', 'machdep.cpu.brand_string']) || process.arch;
}
```

- [ ] **Step 4: Implement `lib/cmd/perf.js`**

```js
// kit perf: runtime CPU of a page with the project's costly features
// (kit.config.js perf.knobs) switched off one at a time, idle and under a
// moving pointer. macOS only. Report only.
//
//   kit perf                                   every knob, local engines, idle + mouse
//   kit perf --engines webkit --off spin --off spin,ticker
//   kit perf --serve                           variants by URL for any device on the LAN
//
// Lessons (sonda-web, 2026-10-03/04) — each one produced confident, wrong numbers:
// Rosetta (assertNative); Chrome on SwiftShader (CHROME_ARGS); count the whole
// process tree (cpu.js); one page per measurement; the window must be
// frontmost; repeat and print the spread.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { enginesFor, loadConfig } from '../config.js';
import { cpuPids, frontmost, machine, sample } from '../cpu.js';
import { CHROME_ARGS, PLAYWRIGHT, assertNative, exeCmd, exeLabel, killProfile, parseEngine } from '../engines.js';
import { parseOff, startProxy } from '../proxy.js';
import { startSite } from '../site.js';

const VIEW = { width: 1440, height: 900 };
const sleep = (s) => Bun.sleep(s * 1000);

export function variants(knobs, off) {
	return (off ?? ['static', '', ...Object.keys(knobs)]).map((v) => {
		const list = parseOff(v, knobs);
		return { name: v === 'static' ? 'static' : v === '' ? 'shipped' : '-' + list.join(',-'), off: list, isStatic: v === 'static' };
	});
}

export function summarise(totals) {
	const s = [...totals].sort((a, b) => a - b);
	return { median: s[Math.floor(s.length / 2)], min: s[0], max: s.at(-1) };
}

export async function run(args) {
	const { values: o } = parseArgs({
		args,
		options: {
			engines: { type: 'string' },
			page: { type: 'string' },
			off: { type: 'string', multiple: true },
			inputs: { type: 'string', default: 'idle,mouse' },
			repeat: { type: 'string', default: '2' },
			warm: { type: 'string', default: '6' },
			measure: { type: 'string', default: '10' },
			origin: { type: 'string' },
			port: { type: 'string', default: '8799' },
			serve: { type: 'boolean' },
			'save-baseline': { type: 'boolean' },
		},
	});
	if (process.platform !== 'darwin') {
		console.error('kit perf: macOS only (CPU sampling reads ps and osascript)');
		return 2;
	}
	assertNative();
	const config = await loadConfig();
	const knobs = config.perf.knobs;
	const pagePath = o.page ?? config.perf.page;
	const site = o.origin ? { origin: o.origin, stop() {} } : await startSite();
	const proxy = startProxy({ origin: site.origin, knobs, block: config.proxy.block, port: o.serve ? Number(o.port) : 0, hostname: o.serve ? '0.0.0.0' : '127.0.0.1' });
	try {
		if (o.serve) {
			const ips = Object.values(networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal);
			for (const host of ['localhost', ...ips.map((i) => i.address)]) console.log(`http://${host}:${proxy.port}${pagePath}?kit-off=static`);
			console.log(`knobs: ${Object.keys(knobs).join(', ')}, or kit-off=static; add &kit-mouse for a synthetic pointer`);
			await new Promise(() => {});
		}
		return await matrix(o, knobs, pagePath, proxy, enginesFor(config, o.engines).map(parseEngine));
	} finally {
		proxy.stop();
		site.stop();
	}
}

async function matrix(o, knobs, pagePath, proxy, engines) {
	const opts = { warm: Number(o.warm), measure: Number(o.measure) };
	const inputs = o.inputs.split(',');
	const results = [];
	const baseline = existsSync('perf-baseline.json') ? JSON.parse(readFileSync('perf-baseline.json', 'utf8')) : null;
	for (const engine of engines) {
		const b = engine.kind === 'playwright' ? await measuredPlaywright(engine.name, opts) : measuredExe(engine, opts);
		console.log(`\n${b.label}  (${VIEW.width}x${VIEW.height} @2x, ${o.repeat}x ${o.measure}s, CPU % of one core)`);
		for (const v of variants(knobs, o.off)) {
			const url = `${proxy.url}${pagePath}${pagePath.includes('?') ? '&' : '?'}kit-off=${v.off.join(',')}`;
			// The static floor turns off whatever exists; a single knob whose element
			// is not on this page would measure nothing, so it is skipped.
			const probes = v.isStatic ? [] : [...new Set(v.off.map((k) => knobs[k].probe).filter(Boolean))];
			const row = [];
			for (const input of inputs) {
				const runs = [];
				// A run that hangs (seen in Firefox late in a matrix) is dropped, not waited on.
				const limit = opts.warm + opts.measure + 45;
				for (let i = 0; i < Number(o.repeat); i++) {
					const r = await Promise.race([b.measure(url, input, probes).catch((e) => (console.error(`kit perf: ${e}`), null)), sleep(limit).then(() => null)]);
					if (proxy.errors.some((e) => e.type === 'proxy')) throw new Error('the dev server went away mid-run — later numbers would be of an error page');
					proxy.errors.length = 0;
					if (r) runs.push(r);
					else console.error(`kit perf: ${v.name} ${input} run ${i + 1} failed or hung past ${limit}s, dropped`);
				}
				if (!runs.length) {
					row.push(`${input} failed`);
					continue;
				}
				if (runs[0].missing) {
					row.push(`skipped: no ${runs[0].missing.join(', ')} on this page`);
					break;
				}
				const s = summarise(runs.map((r) => r.total));
				results.push({ browser: b.label, variant: v.name, input, median: s.median, runs });
				row.push(`${input} ${s.median.toFixed(0).padStart(4)}% (${s.min.toFixed(0)}–${s.max.toFixed(0)})`);
			}
			console.log(`  ${v.name.padEnd(16)} ${row.join('   ')}${delta(baseline, results, b.label, v.name, inputs)}`);
		}
		b.close();
		await sleep(2);
	}
	const sha = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD']).stdout.toString().trim() || 'nogit';
	const report = { date: new Date().toISOString(), sha, machine: machine(), page: pagePath, results };
	mkdirSync(resolve('.kit', 'perf'), { recursive: true });
	writeFileSync(resolve('.kit', 'perf', `${report.date.slice(0, 16).replace(/:/g, '')}-${sha}.json`), JSON.stringify(report, null, 2));
	if (o['save-baseline']) writeFileSync('perf-baseline.json', JSON.stringify(report, null, 2));
	console.log('\nstatic = nothing moves (the floor); -knob = that feature off. Saved to .kit/perf/.');
	return 0;
}

function delta(base, results, label, variant, inputs) {
	if (!base || base.machine !== machine()) return '';
	const engine = label.split(' ')[0];
	const parts = inputs.map((input) => {
		const was = base.results.find((r) => r.browser.split(' ')[0] === engine && r.variant === variant && r.input === input);
		const now = results.find((r) => r.browser === label && r.variant === variant && r.input === input);
		return was && now ? `${input} ${now.median - was.median >= 0 ? '+' : ''}${(now.median - was.median).toFixed(0)}` : null;
	});
	return parts.some(Boolean) ? `   vs baseline: ${parts.filter(Boolean).join(' ')}` : '';
}

async function measuredPlaywright(name, { warm, measure }) {
	const [type, opts] = PLAYWRIGHT[name];
	// A persistent context, not launchServer + connect: Bun's WebSocket client
	// cannot connect to Playwright's server. The throwaway profile directory is
	// on the browser's command line, which is how its processes are found.
	const profile = mkdtempSync(join(tmpdir(), `kit-perf-${name}-`));
	const ctx = await type.launchPersistentContext(profile, {
		...opts,
		headless: false,
		viewport: VIEW,
		deviceScaleFactor: 2,
		args: type === chromium ? CHROME_ARGS : [],
	});
	// Playwright's own builds live under ms-playwright/<name>-<rev>; WebKit's
	// helper processes are XPC services, findable only by that path.
	const markers = [profile, ...(opts.channel === 'chrome' ? [] : [type.executablePath().match(/.*ms-playwright\/[^/]+/)?.[0]])];
	const pid = Math.min(...cpuPids(profile));
	return {
		label: `${name} ${ctx.browser()?.version() ?? ''}`.trim(),
		async measure(url, input, probes) {
			// One retry: Firefox occasionally closes its page after a long-hide throttle (2026-10-04).
			for (let attempt = 0; ; attempt++) {
				const page = await ctx.newPage();
				try {
					await page.goto(url);
					const missing = await page.evaluate((s) => s.filter((sel) => !document.querySelector(sel)), probes);
					if (missing.length) {
						await page.close();
						return { missing };
					}
					await page.bringToFront();
					frontmost(pid);
					await sleep(warm);
					// The window can lose focus while the previous page tears down.
					frontmost(pid);
					let moving = input === 'mouse';
					const mover = (async () => {
						while (moving) await page.mouse.move(Math.random() * VIEW.width, Math.random() * VIEW.height, { steps: 6 });
					})().catch(() => {});
					const result = await sample([pid], markers, measure);
					moving = false;
					await mover;
					await page.close();
					return result;
				} catch (e) {
					await page.close().catch(() => {});
					if (attempt) throw e;
					console.error(`kit perf: ${name} run failed (${String(e).split('\n')[0]}), retrying`);
					await sleep(3);
				}
			}
		},
		// ctx.close() hangs (Chrome's first-run/keychain dialog in a throwaway
		// profile): kill the tree by profile instead.
		close: () => killProfile(profile),
	};
}

// A binary Playwright cannot drive: one headed launch per measurement, a
// throwaway profile, the proxy's synthetic pointer.
function measuredExe(engine, { warm, measure }) {
	return {
		label: exeLabel(engine),
		async measure(url, input) {
			const profile = mkdtempSync(join(tmpdir(), 'kit-perf-exe-'));
			writeFileSync(
				join(profile, 'user.js'),
				['browser.sessionstore.resume_from_crash', 'browser.shell.checkDefaultBrowser', 'app.update.enabled'].map((k) => `user_pref("${k}", false);\n`).join(''),
			);
			const target = input === 'mouse' ? `${url}&kit-mouse` : url;
			const args =
				engine.flavour === 'firefox'
					? ['--no-remote', '--profile', profile, '--width', `${VIEW.width}`, '--height', `${VIEW.height}`, target]
					: [`--user-data-dir=${profile}`, '--no-first-run', `--window-size=${VIEW.width},${VIEW.height}`, ...CHROME_ARGS, target];
			const [cmd, argv] = exeCmd(engine, args);
			const proc = spawn(cmd, argv, { stdio: 'ignore' });
			await sleep(4);
			frontmost(proc.pid);
			await sleep(warm);
			const result = await sample([proc.pid], [profile], measure);
			killProfile(profile);
			await sleep(2);
			return result;
		},
		close() {},
	};
}
```

`lib/cmd/install-browsers.js`:
```js
// kit install-browsers: Playwright's own Chromium, Firefox and WebKit, at the
// kit's pinned Playwright version. macOS only; Linux gets them from the dev shell.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export async function run() {
	const cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
	return Bun.spawnSync(['bun', cli, 'install', 'chromium', 'firefox', 'webkit'], { stdio: ['inherit', 'inherit', 'inherit'] }).exitCode;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/perf.test.js`
Expected: PASS (2 tests on macOS, 3 on Linux).

- [ ] **Step 6: Manual check on the Mac (macOS only; CI cannot test this)**

```bash
cd test/project && bun ../../bin/kit.js perf --engines chromium --repeat 1 --warm 2 --measure 3 --inputs idle
```
Expected: one table with rows `static`, `shipped`, `-spin`, `-ticker`. Each row has a percentage,
and `static` ≤ `shipped`. A file appears in `test/project/.kit/perf/`. Delete `test/project/.kit`
afterwards.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(perf): kit perf, ported from sonda-web's runner with knobs from kit.config.js

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Nix flake, CI, README, release v0.2.0

**Files:**
- Create: `flake.nix`, `flake.lock` (generated)
- Modify: `.github/workflows/test.yml`, `README.md`, `justfile`

**Interfaces:**
- Produces:
  - `packages.<system>.kit` (`bin/kit`)
  - `lib.devShell { pkgs, stack ? "static", packages ? [] }` (stacks: `static`, `kirby`)
  - `devShells.<system>.default`
  - Linux: `PLAYWRIGHT_BROWSERS_PATH`
  - Task 9 adds `KIT_FIREFOX_115` on macOS.

- [ ] **Step 1: Write `flake.nix` with a fake `node_modules` hash**

```nix
{
  description = "web-kit: shared checks and stack dev shells for web projects";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    # Only for playwright-driver: its version must equal the npm `playwright`
    # in package.json (1.63.0), or Linux browsers will not launch. 26.05 ships
    # 1.59.1; unstable had 1.63.0 on 2026-10-05.
    nixpkgs-browsers.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs, nixpkgs-browsers }:
    let
      systems = [ "aarch64-darwin" "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      src = nixpkgs.lib.fileset.toSource {
        root = ./.;
        fileset = nixpkgs.lib.fileset.unions [ ./bin ./lib ./package.json ./bun.lock ];
      };
    in {
      packages = forAll (pkgs: rec {
        # Fixed-output: bun fetches over the network, Nix pins the result by hash.
        # Bump the hash whenever bun.lock changes (build once with lib.fakeHash).
        node-modules = pkgs.stdenvNoCC.mkDerivation {
          pname = "web-kit-node-modules";
          version = "0.2.0";
          inherit src;
          nativeBuildInputs = [ pkgs.bun ];
          dontConfigure = true;
          buildPhase = ''
            export HOME=$TMPDIR
            bun install --frozen-lockfile --production --ignore-scripts
          '';
          installPhase = "cp -r node_modules $out";
          dontFixup = true;
          outputHashMode = "recursive";
          outputHashAlgo = "sha256";
          outputHash = pkgs.lib.fakeHash;
        };
        kit = pkgs.stdenvNoCC.mkDerivation {
          pname = "web-kit";
          version = "0.2.0";
          inherit src;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontBuild = true;
          installPhase = ''
            mkdir -p $out/share/web-kit $out/bin
            cp -r bin lib package.json $out/share/web-kit/
            ln -s ${node-modules} $out/share/web-kit/node_modules
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/kit --add-flags $out/share/web-kit/bin/kit.js
          '';
        };
        default = kit;
      });

      lib.devShell = { pkgs, stack ? "static", packages ? [ ] }:
        let
          system = pkgs.stdenv.hostPlatform.system;
          stacks = {
            static = [ ];
            # Same attribute as the vps PHP-FPM pool (services.phpfpm.pools.*.phpPackage).
            kirby = [ pkgs.php85 pkgs.php85Packages.composer ];
          };
        in pkgs.mkShell {
          packages = [ self.packages.${system}.kit pkgs.just pkgs.bun ] ++ stacks.${stack} ++ packages;
          shellHook = pkgs.lib.optionalString pkgs.stdenv.isLinux ''
            export PLAYWRIGHT_BROWSERS_PATH=${nixpkgs-browsers.legacyPackages.${system}.playwright-driver.browsers}
            export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
          '';
        };

      devShells = forAll (pkgs: { default = self.lib.devShell { inherit pkgs; }; });
    };
}
```

- [ ] **Step 2: Get the real hash and pin it**

Run: `nix build .#node-modules 2>&1 | grep 'got:'`
Expected: `got:    sha256-…`. Replace `pkgs.lib.fakeHash` with that string.

Then run `nix build .#kit && ./result/bin/kit nope`.
Expected: `usage: kit <a11y|compat|…>` and exit 2.

If the hash differs between macOS and Linux (CI shows a mismatch in Step 5), replace `outputHash`
with `{ aarch64-darwin = "…"; x86_64-linux = "…"; aarch64-linux = "…"; }.${pkgs.stdenv.hostPlatform.system}`.

- [ ] **Step 3: Check the Kirby shell's PHP**

Run: `nix develop --impure --expr 'let f = builtins.getFlake (toString ./.); p = f.inputs.nixpkgs.legacyPackages.aarch64-darwin; in f.lib.devShell { pkgs = p; stack = "kirby"; }' -c php -v`
Expected: `PHP 8.5.x`. Then `… -c php -m | grep -E 'gd|intl|mbstring|dom'`, which must list all
four. They are the extensions sonda's CI installs.

- [ ] **Step 4: CI, justfile, README**

`.github/workflows/test.yml`:
```yaml
name: test
on: [push, pull_request]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: DeterminateSystems/determinate-nix-action@v3
      - uses: DeterminateSystems/magic-nix-cache-action@v13
      - run: nix flake check
      - run: nix build .#kit
      - run: nix develop -c sh -c 'bun install --frozen-lockfile && bun test'
```

`justfile`:
```
# list recipes
default:
    @just --list

# bun test — every command against test/project
check:
    bun test

# the node_modules hash after a bun.lock change
hash:
    nix build .#node-modules 2>&1 | grep 'got:' || echo "hash unchanged"
```

`README.md` (replace the whole file):
````markdown
# web-kit

Shared tooling for web projects, delivered as a Nix flake: the `kit` command (checks) and dev
shells per stack. Part of a larger system for delivering sites; see [`docs/roadmap.md`](docs/roadmap.md).

## Use in a project

```nix
# flake.nix
{
  inputs.kit.url = "github:mstcgalis/web-kit/v0.2.0";
  inputs.nixpkgs.follows = "kit/nixpkgs";
  outputs = { kit, nixpkgs, ... }: {
    devShells = nixpkgs.lib.genAttrs [ "aarch64-darwin" "x86_64-linux" ] (system: {
      default = kit.lib.devShell { pkgs = nixpkgs.legacyPackages.${system}; stack = "kirby"; }; # or "static"
    });
  };
}
```

The project's `justfile` must have **`serve-at PORT`**: a foreground server on PORT. Every command
starts the site through it. Static sites use `kit serve-dir DIR {{PORT}}`.

On macOS, run `kit install-browsers` once. On Linux the dev shell provides the browsers.

## Commands

| | | Exit |
|---|---|---|
| `kit a11y` | axe-core, WCAG 2.2 AA + best practice, every crawled page | 1 on violations |
| `kit compat` | `compat.css` against `compat.targets` (browserslist), via doiuse | 1 on findings, 2 if globs match nothing |
| `kit smoke` | every page × engine; runtime errors, `console.error`, broken same-origin requests | 1 on errors |
| `kit shots` | contact sheet at `.kit/shots/…/index.html`: pages × engine × viewport | 0 |
| `kit perf` | CPU per perf knob, idle and mouse; macOS only (see traps below) | 0 |

`--engines a,b` overrides the config for `smoke`, `shots` and `perf`; `--skip REGEX` for the crawl.

## `kit.config.js`

```js
export default {
  pages: { start: ['/', '/does-not-exist'], skip: '^/(media|panel)\\b', limit: 80 },
  engines: { ci: ['chromium', 'firefox', 'webkit'], local: ['chrome', 'firefox', 'webkit', 'exe:firefox:$KIT_FIREFOX_115'] },
  viewports: [[390, 844], [1440, 900]],
  compat: { css: ['assets/css/*.css'], targets: 'defaults, Firefox >= 115', allow: [] },
  proxy: { block: ['panel', 'api', '*.php'] },
  perf: { page: '/', knobs: { zoom: { css: '…', probe: '.slide img' }, seismo: { script: 'seismograph' } } },
};
```

Engines: `chrome` (branded), `chromium`, `firefox`, `webkit`, or `exe:<firefox|chrome>:<path>` for a
binary Playwright cannot drive. The path may be `$VAR`.

Every browser goes through a proxy that injects an error beacon, which is how `exe:` engines report
errors. The proxy also takes `?kit-off=a,b|static`, `?kit-mouse` and `?kit-freeze`, so
`kit perf --serve` variants open on any device on the LAN.

## Measurement traps (perf)

Each of these produced confident, wrong numbers once:
1. Rosetta: an x86 parent launches browsers translated. `kit perf` refuses to run.
2. Chrome on SwiftShader instead of Metal: fixed by `CHROME_ARGS`.
3. Counting one process: count the whole tree, including GPU and XPC helpers.
4. Background tabs keep animating: one page per measurement.
5. Occluded windows aren't composited: the window is forced frontmost before sampling.
6. Firefox ESR updates itself: use the flake's pinned FF115 (`$KIT_FIREFOX_115`).
7. One run proves nothing: the median and range of `--repeat` runs.

## Develop

`nix develop`, then `bun install`, then `just check`. After changing `bun.lock`, run `just hash` and
update `outputHash` in `flake.nix`.

## Licence

AGPL-3.0.
````

- [ ] **Step 5: Push the branch and watch CI**

Ask Daniel before the first push to the kit remote. It is outward-facing.
```bash
git add -A && git commit -m "build: nix flake with kit package and stack dev shells; CI on nix

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin web-kit && gh run watch
```
Expected: green. Fix any Linux-only failures (hash mismatch: Step 2's fallback; a missing browser:
check `ls $PLAYWRIGHT_BROWSERS_PATH`) and commit each fix as `fix(nix): …`.

- [ ] **Step 6: Rename and release (ask Daniel first; outward-facing)**

```bash
gh repo rename web-kit --repo mstcgalis/web-checks --yes
git remote set-url origin git@github.com:mstcgalis/web-kit.git
git switch main && git merge --ff-only web-kit && git tag v0.2.0 && git push origin main v0.2.0
```
Expected: `nix build github:mstcgalis/web-kit/v0.2.0#kit` succeeds from any directory.

---

### Task 9: Pinned Firefox 115 ESR for macOS

**Files:**
- Modify: `flake.nix` (add `packages.aarch64-darwin.firefox-esr-115`, export `KIT_FIREFOX_115`), `README.md` (one line)

**Interfaces:**
- Produces: `$KIT_FIREFOX_115` in the dev shell on aarch64-darwin, which is the path to the
  `firefox` binary inside the store's `Firefox.app`.

- [ ] **Step 1: Find the last 115 ESR build**

Run: `curl -s https://ftp.mozilla.org/pub/firefox/releases/ | grep -o '115\.[0-9.]*esr' | sort -V | tail -1`
Expected: a version such as `115.NN.0esr`. Use it below as `VERSION`.

- [ ] **Step 2: Add the derivation (fake hash first)**

Darwin only, so Linux never evaluates a `.dmg`. In `packages`, change the closing `default = kit;\n      });`
to `default = kit;\n      } // pkgs.lib.optionalAttrs pkgs.stdenv.isDarwin {` + the attribute below + `});`:
```nix
        firefox-esr-115 = pkgs.stdenvNoCC.mkDerivation rec {
          pname = "firefox-esr-115";
          version = "VERSION";
          src = pkgs.fetchurl {
            url = "https://ftp.mozilla.org/pub/firefox/releases/${version}/mac/en-US/Firefox%20${version}.dmg";
            hash = pkgs.lib.fakeHash;
          };
          nativeBuildInputs = [ pkgs.undmg ];
          sourceRoot = ".";
          dontBuild = true;
          dontFixup = true; # re-signing or patching would break the notarised bundle
          installPhase = ''
            mkdir -p $out/Applications
            cp -R Firefox.app $out/Applications/
            # The store is read-only, so it cannot update; the policy also stops it trying.
            mkdir -p $out/Applications/Firefox.app/Contents/Resources/distribution
            echo '{"policies":{"AppAutoUpdate":false,"ManualAppUpdateOnly":true,"DisableAppUpdate":true}}' \
              > $out/Applications/Firefox.app/Contents/Resources/distribution/policies.json
          '';
        };
```

Extend the devShell `shellHook`:
```nix
          shellHook = pkgs.lib.optionalString pkgs.stdenv.isLinux ''
            export PLAYWRIGHT_BROWSERS_PATH=${nixpkgs-browsers.legacyPackages.${system}.playwright-driver.browsers}
            export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
          '' + pkgs.lib.optionalString pkgs.stdenv.isDarwin ''
            export KIT_FIREFOX_115=${self.packages.${system}.firefox-esr-115}/Applications/Firefox.app/Contents/MacOS/firefox
          '';
```

- [ ] **Step 3: Pin the hash and verify it runs from the store**

Run: `nix build .#firefox-esr-115 2>&1 | grep 'got:'`. Put the hash in. Then:
```bash
nix build .#firefox-esr-115 && arch -arm64 ./result/Applications/Firefox.app/Contents/MacOS/firefox --version
```
Expected: `Mozilla Firefox 115.NN.0esr`.

If `undmg` cannot open the image (newer dmgs are APFS), replace `nativeBuildInputs = [ pkgs.undmg ]`
with `[ pkgs._7zz ]` and add `unpackPhase = "7zz x $src -snld";`. If the binary will not run from the
read-only store (Gatekeeper or a missing writable bundle), **stop**. Record what happened in
`docs/roadmap.md` under "1. Checks: deferred", keep the manual `/tmp/ff115` setup in the README, and
skip Step 4.

- [ ] **Step 4: Prove it end to end**

```bash
nix develop -c sh -c 'cd test/project && bun ../../bin/kit.js smoke --engines "exe:firefox:\$KIT_FIREFOX_115"'
```
Expected: `✗ exe:firefox:$KIT_FIREFOX_115 /broken — error: …boom…` and the `404 /missing.png` line;
exit 1.

- [ ] **Step 5: Commit and release v0.2.1**

```bash
git add -A && git commit -m "feat(nix): pinned Firefox 115 ESR for macOS as \$KIT_FIREFOX_115

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Ask Daniel, then `git push origin main && git tag v0.2.1 && git push origin v0.2.1`.

---

### Task 10: Migrate sonda-web onto the kit

All work happens in `~/src/sonda-web` on `dev`. Follow sonda's `AGENTS.md`: one concern per commit,
`just check` green before each, and never touch `content/`.

**Files:**
- Create: `flake.nix`, `flake.lock`, `kit.config.js`
- Modify: `justfile`, `.gitignore`, `.github/workflows/tests.yml`, `docs/perf.md`, `AGENTS.md` (Commands block)
- Delete: `perf/`, and `package.json` + `bun.lock` if nothing else needs them (Step 5)

**Interfaces:**
- Consumes: `kit.lib.devShell` (Task 8), `$KIT_FIREFOX_115` (Task 9), every `kit` command.

- [ ] **Step 1: Flake and config**

`flake.nix`:
```nix
{
  inputs.kit.url = "github:mstcgalis/web-kit/v0.2.1";
  inputs.nixpkgs.follows = "kit/nixpkgs";
  outputs = { kit, nixpkgs, ... }: {
    devShells = nixpkgs.lib.genAttrs [ "aarch64-darwin" "x86_64-linux" ] (system: {
      default = kit.lib.devShell { pkgs = nixpkgs.legacyPackages.${system}; stack = "kirby"; };
    });
  };
}
```

`kit.config.js` (`perf.knobs` copied verbatim from `perf/knobs.js` `KNOBS`):
```js
// web-kit configuration — see the kit README. Knobs: a new animation or effect
// gets one, which is what makes it measurable (docs/perf.md).
export default {
	pages: { start: ['/', '/cs', '/does-not-exist'], skip: '^/(media|assets|panel|api)\\b' },
	engines: {
		ci: ['chromium', 'firefox', 'webkit'],
		local: ['chrome', 'firefox', 'webkit', 'exe:firefox:$KIT_FIREFOX_115'],
	},
	viewports: [[390, 844], [1440, 900]],
	compat: { css: ['assets/css/*.css'], targets: 'defaults, Firefox ESR, Firefox >= 115, Safari >= 17', allow: [] },
	// Kirby sees every proxied request as localhost (where a Panel install needs no login).
	proxy: { block: ['panel', 'api', '*.php'] },
	perf: {
		page: '/',
		knobs: {
			zoom: {
				css: '.slideshow__slide img,.slideshow__slide video{animation:none!important;transform:none!important}',
				probe: '.slideshow__slide img',
			},
			lqip: { css: '.slideshow__slide img{background:none!important}', probe: '.slideshow__slide img' },
			scrim: { css: '.slideshow::before{display:none!important}', probe: '.slideshow' },
			banner: { css: '.edition-banner *{animation:none!important}', probe: '.edition-banner' },
			spot: { css: '.seismograph-spot{display:none!important}', probe: '.seismograph-spot' },
			seismo: { script: 'seismograph' },
			slideshow: { script: 'slideshow' },
			motion: { css: '*,*::before,*::after{animation:none!important;transition:none!important}', probe: 'body' },
		},
	},
};
```

`.gitignore`: add `.kit/` and remove the `perf/results` line, if there is one.

Run: `nix develop -c sh -c 'php -v && kit nope'`
Expected: PHP 8.5, then the kit usage line.

- [ ] **Step 2: justfile recipes**

Replace the `a11y`, `perf`, `perf-serve`, `perf-ff115` and `check` recipes with:
```
# Kit contract: a server for checks on PORT, rendering the fixtures (not content/).
serve-at PORT:
    php -S localhost:{{PORT}} tests/a11y/router.php

# axe-core (WCAG 2.2 AA + best practice) over every fixtures page
a11y:
    kit a11y

# shipped CSS against the browser targets in kit.config.js
compat:
    kit compat

# every fixtures page in every engine: runtime errors, broken requests
smoke:
    kit smoke

# contact sheet across engines and viewports, FF115 included (.kit/shots/)
shots:
    kit shots

# Runtime CPU per knob on the real content/ (docs/perf.md), on its own dev server.
perf *args:
    #!/usr/bin/env bash
    set -euo pipefail
    php -S localhost:8797 kirby/router.php >/dev/null 2>&1 & trap "kill $!" EXIT
    sleep 1
    kit perf --origin http://localhost:8797 {{args}}

# Knob variants by URL for a device on the LAN (old laptop, phone)
perf-serve:
    just perf --serve

# The pre-commit gate: lint + static analysis + tests + a11y + compat + smoke
check:
    composer check
    just test-js
    kit a11y
    kit compat
    kit smoke
```

- [ ] **Step 3: Run each new check and settle its findings**

```bash
nix develop -c just a11y     # expected: same result as before the migration (0 violations)
nix develop -c just compat   # read every finding
nix develop -c just smoke
```

For `compat`, each finding is one of two things:
- **Deliberate progressive enhancement** (inside `@supports`, or fine to lose): add its feature id
  to `compat.allow`, with a comment saying why.
- **A real gap:** stop and show Daniel the list before changing CSS.

**Show Daniel the `targets` line** (it was a guess in the spec) and the allow list before
committing.

For `smoke`, any error on a fixtures page is a real bug. Report it; don't suppress it.

- [ ] **Step 4: Prove perf still reads like before**

Run: `nix develop -c just perf --engines chrome --repeat 1 --warm 12 --measure 6 --inputs idle --off zoom`
Expected: a `-zoom` row close to `docs/perf.md`'s latest Chrome idle readings (shipped ~13, −zoom
~3; ±5).

- [ ] **Step 5: Remove what the kit replaced**

```bash
git rm -r perf
```
Edit `package.json`: remove `web-checks`, `playwright` and the `a11y` script. If nothing is left
but `name` and `private`, delete `package.json` and `bun.lock`. Then:

Run: `nix develop -c just test-js`
Expected: PASS. `bun test` needs no dependencies, because `tests/js` uses only `bun:test` and the
hand-rolled DOM stub.

- [ ] **Step 6: Docs**

- `docs/perf.md`, "The tool":
  - Knobs now live in `kit.config.js`.
  - URL params are `?kit-off=` and `?kit-mouse`.
  - Commands are `just perf`, `just perf-serve`, and `just perf --engines exe:firefox:\$KIT_FIREFOX_115`.
  - Results go to `.kit/perf/`, and `--save-baseline` writes `perf-baseline.json`.
- `docs/perf.md`, "Old browsers": FF115 is pinned by the kit flake. Remove the manual `/tmp/ff115` +
  `policies.json` steps, and keep a one-line note of why pinning matters.
- Keep both findings tables and the measurement traps unchanged.
- `AGENTS.md` Commands block:
  - Add `nix develop` as the way in.
  - Add `just compat`, `just smoke`, `just shots`, `just perf`, `just perf-serve`.
  - Drop `just test-js`'s mention of `bun test`, if it changed.
  - Add a `just check` line listing what it runs.
  - Say that `just check` and `just deploy-*` now run inside `nix develop` (`kit` is only on PATH there).

- [ ] **Step 7: CI**

In `.github/workflows/tests.yml`, replace the `a11y` job with:
```yaml
  checks:
    name: a11y, compat, smoke (web-kit)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: DeterminateSystems/determinate-nix-action@v3
      - uses: DeterminateSystems/magic-nix-cache-action@v13
      - name: Run checks
        run: nix develop -c sh -c 'composer install --no-interaction --prefer-dist && kit a11y && kit compat && kit smoke'
```
Leave `quality` and `phpunit` untouched (moving them to Nix is roadmap module 4).

- [ ] **Step 8: Commit in concerns, each after `nix develop -c just check` is green**

1. `build: nix dev shell from web-kit` (`flake.nix`, `flake.lock`)
2. `test: compat and smoke through web-kit; serve-at for the fixtures` (`kit.config.js`, `justfile`, `.gitignore`)
3. `chore(perf): kit perf replaces perf/` (delete `perf/`, `package.json`/`bun.lock`, `docs/perf.md`, `AGENTS.md`)
4. `ci: checks job runs through nix` (`tests.yml`)

Each message ends with the Co-Authored-By line. Ask Daniel before `git push` / `just deploy-dev`.
After the push, `gh run watch` must show the `checks` job green.

---

## Self-review notes

- **Spec coverage:**
  - contract recipes: Tasks 1 and 10
  - `kit.config.js`: Task 1
  - each lib file: Tasks 1, 2, 4, 5 and 7
  - each command: Tasks 1, 3, 4–7
  - beacon: Task 2
  - packaging and the Playwright pin: Task 8
  - FF115 FOD: Task 9
  - all four spikes: bun deps in Task 8 Step 2, Playwright version in Task 8 Step 5 CI, FF115
    screenshot settled in the spec, dmg in Task 9 Step 3
  - testing: every task
  - sonda migration: Task 10
- **Deviation from the spec, deliberate:** the spec's flake `checks` output becomes a CI step
  (`nix develop -c bun test`). The tests spawn browsers and `just`, which a sandboxed check can't
  reach without extra plumbing.
- **Deviation from the spec, deliberate:** smoke crawls once via HTMLRewriter instead of letting the
  first Playwright engine crawl, so exe-only runs work too.
- **Deviation from the spec, deliberate:** shots freeze animation with the proxy's `?kit-freeze`
  rather than a project `motion` knob, so `shots` works in projects with no knobs.
- **Ceilings marked in code:** the crawl limit, smoke's fixed 500ms settle, and `exeVisit`'s fixed
  launch time.
