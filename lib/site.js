// The project's own server, through the contract's `just serve-at PORT`, and a
// crawl of it. Commands never know the stack; this file is why.
import { spawn } from 'node:child_process';

export async function freePort() {
	const probe = Bun.serve({ hostname: 'localhost', port: 0, fetch: () => new Response() });
	const { port } = probe;
	probe.stop(true);
	return port;
}

// freePort() can lose its port to another process before serve-at binds it;
// serve-at then exits, so a fresh port gets a couple more tries.
export async function startSite(tries = 3) {
	for (let i = 1; ; i++) {
		try {
			return await startSiteOnce();
		} catch (e) {
			if (i >= tries || !e.exited) throw e;
		}
	}
}

async function startSiteOnce() {
	const port = await freePort();
	// detached: the recipe's shell is the group leader, so one kill takes the real server too.
	const child = spawn('just', ['serve-at', String(port)], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
	let exited = false;
	let stopped = false;
	child.on('exit', () => (exited = true));
	child.on('error', () => (exited = true));
	// Pass the server's stderr through, minus just's "terminated by signal 15" on our own kill.
	child.stderr.on('data', (d) => stopped || process.stderr.write(d));
	const origin = `http://localhost:${port}`;
	const stop = () => {
		stopped = true;
		try {
			process.kill(-child.pid);
		} catch {}
	};
	for (let i = 0; ; i++) {
		if (await fetch(origin).then(() => true, () => false)) return { origin, stop };
		if (exited || i > 100) {
			stop();
			throw Object.assign(new Error(`\`just serve-at ${port}\` ${exited ? 'exited' : 'never answered'} on ${origin}`), { exited });
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
