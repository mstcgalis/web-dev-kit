import { expect, test } from 'bun:test';
import { parseEngine } from '../lib/engines.js';

test('parseEngine: playwright names and exe specs', () => {
	expect(parseEngine('webkit')).toEqual({ kind: 'playwright', name: 'webkit' });
	expect(parseEngine('exe:firefox:/opt/ff/firefox')).toEqual({ kind: 'exe', flavour: 'firefox', path: '/opt/ff/firefox', name: 'exe:firefox:/opt/ff/firefox' });
	expect(() => parseEngine('opera')).toThrow('unknown engine "opera"');
	expect(() => parseEngine('exe:safari:/x')).toThrow('exe:firefox:<path> or exe:chrome:<path>');
});
