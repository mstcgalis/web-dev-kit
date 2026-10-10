export default {
	pages: { start: ['/'] },
	engines: { ci: ['chromium', 'firefox', 'webkit'], local: ['chrome', 'firefox', 'webkit'] },
	viewports: [[390, 844], [1440, 900]],
	compat: { css: ['assets/css/*.css'], targets: 'defaults', allow: [] },
	proxy: { block: ['panel', 'api', '*.php'] },
};
