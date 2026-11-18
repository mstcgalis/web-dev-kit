import { expect, test } from 'bun:test';
import { chmodSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wdk } from './run.js';

const ROOT = join(import.meta.dir, '..');
const sh = (args, cwd, opts = {}) => {
	const r = Bun.spawnSync(args, { cwd, ...opts });
	return { code: r.exitCode, err: r.stderr.toString() };
};
const repo = () => {
	const dir = mkdtempSync(join(tmpdir(), 'wdk-verified-'));
	cpSync(join(ROOT, 'templates', 'static'), dir, { recursive: true });
	for (const a of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']]) sh(['git', ...a], dir);
	return dir;
};
const hook = async (dir, input = {}) => {
	const p = Bun.spawn(['bun', join(ROOT, 'bin', 'wdk.js'), 'verified', '--hook'], { cwd: dir, stdin: new Blob([JSON.stringify(input)]), stderr: 'pipe' });
	const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
	return { code, err };
};

test.concurrent('verified: a fresh clean clone passes, an edit fails until check marks the tree, a commit keeps the pass', async () => {
	const dir = repo();
	expect((await wdk(['verified'], {}, dir)).code).toBe(0);
	writeFileSync(join(dir, 'site', 'new.html'), '<p>x</p>');
	expect((await wdk(['verified'], {}, dir)).code).toBe(1);
	sh(['bun', '-e', `import { mark } from '${ROOT}/lib/cmd/verified.js'; mark()`], dir);
	expect((await wdk(['verified'], {}, dir)).code).toBe(0);
	sh(['git', 'add', '-A'], dir);
	sh(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], dir);
	expect((await wdk(['verified'], {}, dir)).code).toBe(0);
	writeFileSync(join(dir, 'site', 'new.html'), '<p>y</p>');
	expect((await wdk(['verified'], {}, dir)).code).toBe(1);
	expect((await wdk(['verified'], {}, mkdtempSync(join(tmpdir(), 'wdk-nogit-')))).code).toBe(0); // no git: nothing to block
});

test.concurrent('verified --hook sends the agent back once with the reason, through the template recipe', async () => {
	const dir = repo();
	writeFileSync(join(dir, 'site', 'new.html'), '<p>x</p>');
	const back = await hook(dir);
	expect(back.code).toBe(2);
	expect(back.err).toContain('just check');
	expect((await hook(dir, { stop_hook_active: true })).code).toBe(0);
	// The template's recipe passes stdin and the exit code through just.
	const bin = mkdtempSync(join(tmpdir(), 'wdk-bin-'));
	writeFileSync(join(bin, 'wdk'), `#!/bin/sh\nexec bun ${ROOT}/bin/wdk.js "$@"\n`);
	chmodSync(join(bin, 'wdk'), 0o755);
	const r = sh(['just', 'stop-hook'], dir, { stdin: new Blob(['{}']), env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
	expect(r.code).toBe(2);
	expect(r.err).toContain('just check');
});
