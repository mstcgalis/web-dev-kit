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
