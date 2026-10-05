import { expect, test } from 'bun:test';
import { parseEngine } from '../lib/engines.js';

test('parseEngine: playwright names and exe specs', () => {
	expect(parseEngine('webkit')).toEqual({ kind: 'playwright', name: 'webkit' });
	expect(parseEngine('exe:firefox:/opt/ff/firefox')).toEqual({ kind: 'exe', flavour: 'firefox', path: '/opt/ff/firefox', name: 'exe:firefox:/opt/ff/firefox' });
	expect(() => parseEngine('opera')).toThrow('unknown engine "opera"');
	expect(() => parseEngine('exe:safari:/x')).toThrow('exe:firefox:<path> or exe:chrome:<path>');
});

test('parseEngine expands $VAR paths and names a missing one', () => {
	process.env.KIT_TEST_FF = '/opt/ff/firefox';
	expect(parseEngine('exe:firefox:$KIT_TEST_FF').path).toBe('/opt/ff/firefox');
	delete process.env.KIT_TEST_FF;
	expect(() => parseEngine('exe:firefox:$KIT_TEST_FF')).toThrow('$KIT_TEST_FF is not set');
});
