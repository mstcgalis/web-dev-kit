// Browsers. Two kinds:
//   playwright:  chrome (branded), chromium, firefox, webkit
//   exe:<firefox|chrome>:<path>  a binary Playwright cannot drive (FF115);
//                path may be $VAR (the kit dev shell exports KIT_FIREFOX_115)
// Lessons from sonda-web's perf runs live here so every command inherits them.
import { spawnSync } from 'node:child_process';
import { chromium, firefox, webkit } from 'playwright';

export const PLAYWRIGHT = {
	chrome: [chromium, { channel: 'chrome' }],
	// The full build in new-headless mode: nixpkgs' Linux browsers ship it,
	// the separate headless shell is not guaranteed there.
	chromium: [chromium, { channel: 'chromium' }],
	firefox: [firefox, {}],
	webkit: [webkit, {}],
};

// Without these Playwright runs branded Chrome on SwiftShader (software GL):
// an animation costs ~2 cores that hardware-composited Chrome never spends.
// Checked 2026-10-04 by reading the WebGL renderer string in the measured page.
export const CHROME_ARGS = [
	'--disable-backgrounding-occluded-windows',
	'--disable-renderer-backgrounding',
	'--no-first-run',
	'--no-default-browser-check',
	'--use-angle=metal',
	'--disable-features=UnsafeSwiftShader',
];

export function parseEngine(spec) {
	if (spec.startsWith('exe:')) {
		const [, flavour, ...rest] = spec.split(':');
		const path = rest.join(':');
		if (!['firefox', 'chrome'].includes(flavour) || !path) throw new Error(`engine "${spec}": expected exe:firefox:<path> or exe:chrome:<path>`);
		return { kind: 'exe', flavour, path, name: spec };
	}
	if (!PLAYWRIGHT[spec]) throw new Error(`unknown engine "${spec}" — ${Object.keys(PLAYWRIGHT).join(', ')}, or exe:<firefox|chrome>:<path>`);
	return { kind: 'playwright', name: spec };
}

// An x86 parent makes a universal browser launch translated: every timing and
// CPU number is garbage.
export function assertNative() {
	if (process.platform !== 'darwin') return;
	const translated = spawnSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' }).stdout.trim();
	if (translated === '1') throw new Error('running under Rosetta — browsers would launch translated. Use a native bun.');
}

export function launch(name) {
	const [type, opts] = PLAYWRIGHT[name];
	return type.launch(opts);
}
