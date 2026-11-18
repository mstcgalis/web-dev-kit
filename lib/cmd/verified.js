// wdk verified: has the working tree passed `wdk check` as it is now? Exit 0 yes, 1 no.
// `--hook` is the Claude Code Stop hook: an unchecked change sends the agent back once (exit 2, reason on stderr).
// The fingerprint is git's tree hash of the working files (tracked + untracked, .gitignore honoured), so
// committing doesn't invalidate a pass, and any edit does.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MARK = '.wdk/checked';
const git = (args, env) => {
	const r = Bun.spawnSync(['git', ...args], { env: { ...process.env, ...env } });
	return r.exitCode ? null : r.stdout.toString().trim();
};

// null outside a git repo: nothing to compare, so nothing to block.
export function tree() {
	const index = git(['rev-parse', '--git-path', 'index']);
	if (index === null) return null;
	const tmp = mkdtempSync(join(tmpdir(), 'wdk-index-'));
	const env = { GIT_INDEX_FILE: join(tmp, 'index') };
	try {
		if (existsSync(index)) copyFileSync(index, env.GIT_INDEX_FILE); // reuse git's stat cache: no rehash of unchanged files
		return git(['add', '-A'], env) === null ? null : git(['write-tree'], env);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

export function mark() {
	const t = tree();
	if (!t) return;
	mkdirSync('.wdk', { recursive: true });
	writeFileSync(MARK, t);
}

export function verified() {
	const t = tree();
	if (!t) return true;
	if (existsSync(MARK)) return readFileSync(MARK, 'utf8').trim() === t;
	// Never checked here (a fresh clone): a clean tree is the pushed state, which CI checked.
	return t === git(['rev-parse', 'HEAD^{tree}']);
}

export async function run(args) {
	if (!args.includes('--hook')) return verified() ? 0 : 1;
	const input = JSON.parse((await Bun.stdin.text()) || '{}');
	// Already sent back once: let it stop, the agent reports why the check doesn't pass.
	if (input.stop_hook_active || verified()) return 0;
	console.error('wdk: files changed since the last passing `just check`. Run it and fix what it finds, or tell the user why you are stopping with it failing.');
	return 2;
}
