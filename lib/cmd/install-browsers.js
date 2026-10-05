// kit install-browsers: Playwright's own Chromium, Firefox and WebKit, at the
// kit's pinned Playwright version. macOS only; Linux gets them from the dev shell.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export async function run() {
	const cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
	return Bun.spawnSync([process.execPath, cli, 'install', 'chromium', 'firefox', 'webkit'], { stdio: ['inherit', 'inherit', 'inherit'] }).exitCode;
}
