// kit perf: runtime CPU of a page with the project's costly features
// (kit.config.js perf.knobs) switched off one at a time, idle and under a
// moving pointer. macOS only. Report only.
//
//   kit perf                                   every knob, local engines, idle + mouse
//   kit perf --engines webkit --off spin --off spin,ticker
//   kit perf --serve                           variants by URL for any device on the LAN
//
// Lessons (sonda-web, 2026-10-03/04) — each one produced confident, wrong numbers:
// Rosetta (assertNative); Chrome on SwiftShader (CHROME_ARGS); count the whole
// process tree (cpu.js); one page per measurement; the window must be
// frontmost; repeat and print the spread.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { enginesFor, loadConfig } from '../config.js';
import { cpuPids, frontmost, machine, sample } from '../cpu.js';
import { CHROME_ARGS, PLAYWRIGHT, assertNative, exeCmd, exeLabel, killProfile, parseEngine } from '../engines.js';
import { parseOff, startProxy } from '../proxy.js';
import { startSite } from '../site.js';

const VIEW = { width: 1440, height: 900 };
const sleep = (s) => Bun.sleep(s * 1000);
const TIMEOUT = Symbol('timeout');

export function variants(knobs, off) {
	return (off ?? ['static', '', ...Object.keys(knobs)]).map((v) => {
		const list = parseOff(v, knobs);
		return { name: v === 'static' ? 'static' : v === '' ? 'shipped' : '-' + list.join(',-'), off: list, isStatic: v === 'static' };
	});
}

export function summarise(totals) {
	const s = [...totals].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return { median: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2, min: s[0], max: s.at(-1) };
}

export async function run(args) {
	const { values: o } = parseArgs({
		args,
		options: {
			engines: { type: 'string' },
			page: { type: 'string' },
			off: { type: 'string', multiple: true },
			inputs: { type: 'string', default: 'idle,mouse' },
			repeat: { type: 'string', default: '2' },
			warm: { type: 'string', default: '6' },
			measure: { type: 'string', default: '10' },
			origin: { type: 'string' },
			port: { type: 'string', default: '8799' },
			serve: { type: 'boolean' },
			'save-baseline': { type: 'boolean' },
		},
	});
	if (process.platform !== 'darwin') {
		console.error('kit perf: macOS only (CPU sampling reads ps and osascript)');
		return 2;
	}
	assertNative();
	machine(); // cache it now; later calls must not spawn while pages load
	const config = await loadConfig();
	const knobs = config.perf.knobs;
	const pagePath = o.page ?? config.perf.page;
	const site = o.origin ? { origin: o.origin, stop() {} } : await startSite();
	const proxy = startProxy({ origin: site.origin, knobs, block: config.proxy.block, port: o.serve ? Number(o.port) : 0, hostname: o.serve ? '0.0.0.0' : '127.0.0.1' });
	try {
		if (o.serve) {
			const ips = Object.values(networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal);
			for (const host of ['localhost', ...ips.map((i) => i.address)]) console.log(`http://${host}:${proxy.port}${pagePath}?kit-off=static`);
			console.log(`knobs: ${Object.keys(knobs).join(', ')}, or kit-off=static; add &kit-mouse for a synthetic pointer`);
			await new Promise(() => {});
		}
		return await matrix(o, knobs, pagePath, proxy, enginesFor(config, o.engines).map(parseEngine));
	} finally {
		proxy.stop();
		site.stop();
	}
}

async function matrix(o, knobs, pagePath, proxy, engines) {
	const opts = { warm: Number(o.warm), measure: Number(o.measure) };
	const inputs = o.inputs.split(',');
	const results = [];
	const baseline = existsSync('perf-baseline.json') ? JSON.parse(readFileSync('perf-baseline.json', 'utf8')) : null;
	for (const engine of engines) {
		const b = engine.kind === 'playwright' ? await measuredPlaywright(engine.name, opts) : measuredExe(engine, opts);
		try {
			console.log(`\n${b.label}  (${VIEW.width}x${VIEW.height} @2x, ${o.repeat}x ${o.measure}s, CPU % of one core)`);
			for (const v of variants(knobs, o.off)) {
				const url = `${proxy.url}${pagePath}${pagePath.includes('?') ? '&' : '?'}kit-off=${v.off.join(',')}`;
				// The static floor turns off whatever exists; a single knob whose element
				// is not on this page would measure nothing, so it is skipped.
				const probes = v.isStatic ? [] : [...new Set(v.off.map((k) => knobs[k].probe).filter(Boolean))];
				const row = [];
				for (const input of inputs) {
					const runs = [];
					// A run that hangs (seen in Firefox late in a matrix) is dropped, not waited on.
					const limit = opts.warm + opts.measure + 45;
					for (let i = 0; i < Number(o.repeat); i++) {
						const r = await Promise.race([b.measure(url, input, probes).catch((e) => (console.error(`kit perf: ${e}`), null)), sleep(limit).then(() => TIMEOUT)]);
						// The abandoned run is still alive; kill it before it skews the next one.
						if (r === TIMEOUT) await b.abandon();
						if (proxy.errors.some((e) => e.type === 'proxy')) throw new Error('the dev server went away mid-run — later numbers would be of an error page');
						proxy.errors.length = 0;
						if (r && r !== TIMEOUT) runs.push(r);
						else console.error(`kit perf: ${v.name} ${input} run ${i + 1} failed or hung past ${limit}s, dropped`);
					}
					if (!runs.length) {
						row.push(`${input} failed`);
						continue;
					}
					if (runs.some((r) => r.missing)) {
						row.push(`skipped: no ${runs.find((r) => r.missing).missing.join(', ')} on this page`);
						break;
					}
					const s = summarise(runs.map((r) => r.total));
					results.push({ browser: b.label, variant: v.name, input, median: s.median, runs });
					row.push(`${input} ${s.median.toFixed(0).padStart(4)}% (${s.min.toFixed(0)}–${s.max.toFixed(0)})`);
				}
				console.log(`  ${v.name.padEnd(16)} ${row.join('   ')}${delta(baseline, results, b.label, v.name, inputs)}`);
			}
		} finally {
			await b.close();
		}
		await sleep(2);
	}
	const sha = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD']).stdout.toString().trim() || 'nogit';
	const report = { date: new Date().toISOString(), sha, machine: machine(), page: pagePath, results };
	mkdirSync(resolve('.kit', 'perf'), { recursive: true });
	writeFileSync(resolve('.kit', 'perf', `${report.date.slice(0, 16).replace(/:/g, '')}-${sha}.json`), JSON.stringify(report, null, 2));
	if (o['save-baseline']) {
		// Rows this run did not measure (--off, --engines) stay as they were.
		const key = (r) => `${r.browser}|${r.variant}|${r.input}`;
		const fresh = new Set(results.map(key));
		const kept = (baseline?.results ?? []).filter((r) => !fresh.has(key(r)));
		writeFileSync('perf-baseline.json', JSON.stringify({ ...report, results: [...kept, ...results] }, null, 2));
	}
	console.log('\nstatic = nothing moves (the floor); -knob = that feature off. Saved to .kit/perf/.');
	return 0;
}

function delta(base, results, label, variant, inputs) {
	if (!base || base.machine !== machine()) return '';
	const engine = label.split(' ')[0];
	const parts = inputs.map((input) => {
		const was = base.results.find((r) => r.browser.split(' ')[0] === engine && r.variant === variant && r.input === input);
		const now = results.find((r) => r.browser === label && r.variant === variant && r.input === input);
		return was && now ? `${input} ${now.median - was.median >= 0 ? '+' : ''}${(now.median - was.median).toFixed(0)}` : null;
	});
	return parts.some(Boolean) ? `   vs baseline: ${parts.filter(Boolean).join(' ')}` : '';
}

async function launchPlaywright(name) {
	const [type, opts] = PLAYWRIGHT[name];
	// A persistent context, not launchServer + connect: Bun's WebSocket client
	// cannot connect to Playwright's server. The throwaway profile directory is
	// on the browser's command line, which is how its processes are found.
	const profile = mkdtempSync(join(tmpdir(), `kit-perf-${name}-`));
	try {
		const ctx = await type.launchPersistentContext(profile, {
			...opts,
			headless: false,
			viewport: VIEW,
			deviceScaleFactor: 2,
			args: type === chromium ? CHROME_ARGS : [],
		});
		// Playwright's own builds live under ms-playwright/<name>-<rev>; WebKit's
		// helper processes are XPC services, findable only by that path.
		const markers = [profile, ...(opts.channel === 'chrome' ? [] : [type.executablePath().match(/.*ms-playwright\/[^/]+/)?.[0]])];
		const pids = await cpuPids(profile);
		if (!pids.length) throw new Error(`no browser process found for profile ${profile}`);
		return { ctx, profile, markers, pid: Math.min(...pids) };
	} catch (e) {
		await killProfile(profile);
		throw e;
	}
}

async function measuredPlaywright(name, { warm, measure }) {
	let live = await launchPlaywright(name);
	return {
		label: `${name} ${live.ctx.browser()?.version() ?? ''}`.trim(),
		async measure(url, input, probes) {
			const { ctx, pid, markers } = live; // captured: a relaunch must not hand this run a new browser
			// One retry: Firefox occasionally closes its page after a long-hide throttle (2026-10-04).
			for (let attempt = 0; ; attempt++) {
				const page = await ctx.newPage();
				try {
					await page.goto(url);
					const missing = await page.evaluate((s) => s.filter((sel) => !document.querySelector(sel)), probes);
					if (missing.length) {
						await page.close();
						return { missing };
					}
					await page.bringToFront();
					await frontmost(pid);
					await sleep(warm);
					// The window can lose focus while the previous page tears down.
					await frontmost(pid);
					let moving = input === 'mouse';
					const mover = (async () => {
						while (moving) await page.mouse.move(Math.random() * VIEW.width, Math.random() * VIEW.height, { steps: 6 });
					})().catch(() => {});
					const result = await sample([pid], markers, measure);
					moving = false;
					await mover;
					await page.close();
					return result;
				} catch (e) {
					await page.close().catch(() => {});
					if (attempt) throw e;
					console.error(`kit perf: ${name} run failed (${String(e).split('\n')[0]}), retrying`);
					await sleep(3);
				}
			}
		},
		// A hung run may have wedged the browser: start over with a fresh one.
		async abandon() {
			await killProfile(live.profile);
			live = await launchPlaywright(name);
		},
		// ctx.close() hangs (Chrome's first-run/keychain dialog in a throwaway
		// profile): kill the tree by profile instead.
		close: () => killProfile(live.profile),
	};
}

// A binary Playwright cannot drive: one headed launch per measurement, a
// throwaway profile, the proxy's synthetic pointer.
function measuredExe(engine, { warm, measure }) {
	let current;
	return {
		label: exeLabel(engine),
		async measure(url, input) {
			const profile = (current = mkdtempSync(join(tmpdir(), 'kit-perf-exe-')));
			try {
				writeFileSync(
					join(profile, 'user.js'),
					['browser.sessionstore.resume_from_crash', 'browser.shell.checkDefaultBrowser', 'app.update.enabled'].map((k) => `user_pref("${k}", false);\n`).join(''),
				);
				const target = input === 'mouse' ? `${url}&kit-mouse` : url;
				const args =
					engine.flavour === 'firefox'
						? ['--no-remote', '--profile', profile, '--width', `${VIEW.width}`, '--height', `${VIEW.height}`, target]
						: [`--user-data-dir=${profile}`, '--no-first-run', `--window-size=${VIEW.width},${VIEW.height}`, ...CHROME_ARGS, target];
				const [cmd, argv] = exeCmd(engine, args);
				const proc = spawn(cmd, argv, { stdio: 'ignore' });
				// A bad path surfaces as a rejected run, not an unhandled 'error' event.
				const failed = new Promise((_, reject) => proc.on('error', (e) => reject(new Error(`${cmd}: ${e.message}`))));
				return await Promise.race([
					failed,
					(async () => {
						await sleep(4);
						await frontmost(proc.pid);
						await sleep(warm);
						return sample([proc.pid], [profile], measure);
					})(),
				]);
			} finally {
				await killProfile(profile);
				await sleep(2);
			}
		},
		abandon: () => current && killProfile(current),
		close() {},
	};
}
