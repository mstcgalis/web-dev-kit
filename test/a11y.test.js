import { expect, test } from 'bun:test';

const run = (...args) => Bun.spawnSync(['bun', 'bin/web-checks.js', 'a11y', ...args], { cwd: `${import.meta.dir}/..` });

test('crawls from the start paths and fails on the violation one link away', () => {
	const r = run('--dir', 'test/site', '--port', '8811');
	const out = r.stdout.toString();
	expect(out).toContain('✗ /about — image-alt');
	expect(out).toContain('3 pages, 1 violation(s)');
	expect(r.exitCode).toBe(1);
}, 30_000);

test('passes when the crawl stays on clean pages', () => {
	const r = run('--dir', 'test/site', '--port', '8812', '--skip', '^/about');
	expect(r.stdout.toString()).toContain('2 pages, 0 violation(s)');
	expect(r.exitCode).toBe(0);
}, 30_000);

test('--serve runs a command with {port} substituted', () => {
	const r = run('--serve', 'python3 -m http.server {port} -d test/site', '--port', '8813', '--start', '/');
	expect(r.exitCode).toBe(1);
}, 60_000);
