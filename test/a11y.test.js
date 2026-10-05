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
