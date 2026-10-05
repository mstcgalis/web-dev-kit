// wdk serve-dir DIR PORT: the static stack's serve-at. Static hosting the way
// Netlify/nginx do it: /x → x, x.html or x/index.html; else 404.html with 404.
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export async function run([dir, port]) {
	if (!dir || !port) {
		console.error('usage: wdk serve-dir DIR PORT');
		return 2;
	}
	const resolvedDir = resolve(dir);
	Bun.serve({
		hostname: 'localhost',
		port: Number(port),
		async fetch(req) {
			let pathname;
			try {
				pathname = decodeURIComponent(new URL(req.url).pathname);
			} catch {
				return new Response('Bad request', { status: 400 });
			}
			const p = resolve(join(resolvedDir, pathname));
			if (!p.startsWith(resolvedDir + '/') && p !== resolvedDir) {
				const notFound = Bun.file(join(resolvedDir, '404.html'));
				return new Response((await notFound.exists()) ? notFound : 'Not found', { status: 404, headers: { 'content-type': 'text/html' } });
			}
			for (const f of [p, `${p}.html`, join(p, 'index.html')]) {
				if (statSync(f, { throwIfNoEntry: false })?.isFile()) return new Response(Bun.file(f));
			}
			const notFound = Bun.file(join(resolvedDir, '404.html'));
			return new Response((await notFound.exists()) ? notFound : 'Not found', { status: 404, headers: { 'content-type': 'text/html' } });
		},
	});
	await new Promise(() => {}); // serve until killed
}
