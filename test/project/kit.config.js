export default {
	pages: { start: ['/', '/does-not-exist'] },
	engines: { ci: ['chromium'], local: ['chromium'] },
	viewports: [[390, 844], [1280, 800]],
	compat: { css: ['site/*.css'], targets: 'Firefox >= 115', allow: [] },
	proxy: { block: ['panel', 'api', '*.php'] },
	perf: {
		page: '/',
		knobs: {
			spin: { css: '.spin{animation:none!important}', probe: '.spin' },
			ticker: { script: 'ticker' },
		},
	},
};
