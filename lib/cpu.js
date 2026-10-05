// CPU of a whole browser (GPU and content processes included), from `ps`.
// macOS only. Checked 2026-10-04: two busy loops read ~100% of one core each
// over 5s, matching `top -l`.
// Async throughout: the proxy shares our event loop, and a blocking ps or
// osascript would freeze the page load being measured.
import { spawnSync } from 'node:child_process';

async function sh(cmd, args) {
	const p = Bun.spawn([cmd, ...args], { stdout: 'pipe', stderr: 'ignore' });
	const out = await new Response(p.stdout).text();
	await p.exited;
	return out.trim();
}

export async function processes() {
	return (await sh('ps', ['-axo', 'pid=,ppid=,cputime=,command='])).split('\n').map((line) => {
		const [pid, ppid, time, ...cmd] = line.trim().split(/\s+/);
		const secs = time.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
		return { pid: +pid, ppid: +ppid, secs, cmd: cmd.join(' ') };
	});
}

export async function cpuPids(marker) {
	return (await processes()).filter((p) => p.cmd.includes(marker)).map((p) => p.pid);
}

// Firefox and Chrome composite in a GPU process; WebKit's helpers are XPC
// services, not children — they are found by marker, not by parentage.
export async function cpuByKind(rootPids, markers) {
	const procs = await processes();
	const kids = new Map();
	for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
	const stack = procs.filter((p) => rootPids.includes(p.pid) || markers.some((m) => m && p.cmd.includes(m)));
	const seen = new Set();
	const kinds = {};
	while (stack.length) {
		const p = stack.pop();
		if (seen.has(p.pid)) continue;
		seen.add(p.pid);
		const kind = /GPU/i.test(p.cmd) ? 'gpu' : rootPids.includes(p.pid) ? 'browser' : 'other';
		kinds[kind] = (kinds[kind] ?? 0) + p.secs;
		stack.push(...(kids.get(p.pid) ?? []));
	}
	return kinds;
}

// macOS stops compositing occluded windows: a background window reads near zero.
export function frontmost(pid) {
	return sh('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`]);
}

export async function sample(pids, markers, seconds) {
	const a = await cpuByKind(pids, markers);
	await Bun.sleep(seconds * 1000);
	const b = await cpuByKind(pids, markers);
	const pct = (k) => (100 * ((b[k] ?? 0) - (a[k] ?? 0))) / seconds;
	return { total: Object.keys(b).reduce((s, k) => s + pct(k), 0), gpu: pct('gpu') };
}

// Once, at startup, before any page is loading.
export function machine() {
	return spawnSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).stdout.trim() || process.arch;
}
