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
