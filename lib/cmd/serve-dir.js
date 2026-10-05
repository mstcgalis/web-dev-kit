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
