#!/usr/bin/env bun
// kit <command>: one file per command in lib/cmd/, each exporting run(args) → exit code.
const COMMANDS = ['a11y', 'compat', 'smoke', 'shots', 'perf', 'serve-dir', 'install-browsers'];
const [cmd, ...args] = process.argv.slice(2);
if (!COMMANDS.includes(cmd)) {
	console.error(`usage: kit <${COMMANDS.join('|')}> [options] — see the web-kit README`);
	process.exit(2);
}
const { run } = await import(`../lib/cmd/${cmd}.js`);
process.exit((await run(args)) ?? 0);
