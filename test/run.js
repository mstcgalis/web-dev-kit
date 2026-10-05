// Runs the kit CLI the way a project does: from the fixture project's root.
export const PROJECT = `${import.meta.dir}/project`;
export function kit(args, env = {}) {
	const r = Bun.spawnSync(['bun', `${import.meta.dir}/../bin/kit.js`, ...args], { cwd: PROJECT, env: { ...process.env, ...env } });
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
