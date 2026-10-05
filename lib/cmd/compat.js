// kit compat: shipped CSS against the project's browser targets (caniuse data
// through doiuse). Static and fast; it says nothing about JS — `kit smoke` in
// old engines covers that. Progressive enhancement inside @supports is still
// reported: list those feature ids in compat.allow.
import { Glob } from 'bun';
import { parseArgs } from 'node:util';
import doiuse from 'doiuse';
import postcss from 'postcss';
import { loadConfig } from '../config.js';

export async function run(args) {
	parseArgs({ args, options: {} });
	const { compat } = await loadConfig();
	if (!compat.css.length) {
		console.error('kit compat: set compat.css (globs of shipped stylesheets) in kit.config.js');
		return 2;
	}
	const files = [];
	for (const pattern of compat.css) for await (const file of new Glob(pattern).scan('.')) files.push(file);
	if (!files.length) {
		console.error(`kit compat: compat.css ${JSON.stringify(compat.css)} matched no files`);
		return 2;
	}
	let found = 0;
	for (const file of files.sort()) {
		const report = (usage) => {
			found++;
			// doiuse prefixes "<abs path>:<line>:<col>: "; keep only the message.
			console.log(`✗ ${file}:${usage.usage.source.start.line} — ${usage.message.split(': ').slice(1).join(': ')}`);
		};
		await postcss([doiuse({ browsers: compat.targets, ignore: compat.allow, onFeatureUsage: report })]).process(await Bun.file(file).text(), { from: file });
	}
	console.log(`${files.length} file(s), ${found} unsupported feature use(s) for "${compat.targets}"`);
	return found ? 1 : 0;
}
