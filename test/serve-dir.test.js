import { afterAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

test('serve-dir blocks path traversal with %2e%2e', async () => {
	const port = 0; // Will be assigned dynamically
	const dir = join(import.meta.dir, 'project/site');

	// Find a free port
	const probe = Bun.serve({ hostname: 'localhost', port: 0, fetch: () => new Response() });
	const actualPort = probe.port;
	probe.stop(true);

	const child = spawn('bun', ['bin/kit.js', 'serve-dir', dir, String(actualPort)], {
		cwd: `${import.meta.dir}/..`,
		stdio: 'ignore',
	});

	// Wait for server to start
	await Bun.sleep(500);

	try {
		// Try to escape with %2e%2e (URL-encoded ..)
		const res = await fetch(`http://localhost:${actualPort}/%2e%2e/package.json`);
		expect(res.status).toBe(404);
		expect(res.headers.get('content-type')).toContain('text/html');
	} finally {
		child.kill();
		await new Promise(resolve => child.once('exit', resolve));
	}
}, 10_000);
