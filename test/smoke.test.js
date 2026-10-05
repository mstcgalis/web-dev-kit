import { expect, test } from 'bun:test';
import { chromium } from 'playwright';
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

test('smoke exits 2 on invalid engine', () => {
	const r = kit(['smoke', '--engines', 'bogus']);
	expect(r.err).toContain('kit smoke:');
	expect(r.err).toContain('unknown engine');
	expect(r.code).toBe(2);
});

test('exe engines report through the beacon and the proxy', () => {
	const r = kit(['smoke', '--engines', 'exe:chrome:$KIT_TEST_CHROME'], { KIT_TEST_CHROME: chromium.executablePath() });
	expect(r.out).toMatch(/✗ exe:chrome:\$KIT_TEST_CHROME \/broken — error: .*boom/);
	expect(r.out).toContain('✗ exe:chrome:$KIT_TEST_CHROME /broken — 404 /missing.png');
	expect(r.out).not.toContain('/does-not-exist —');
	expect(r.code).toBe(1);
}, 120_000);
