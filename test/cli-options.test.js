import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parseBoolean, parseNumberOption } from '../scripts/lib/cli-options.mjs';

test('parseNumberOption refuses values it cannot read instead of falling back', () => {
  assert.equal(parseNumberOption(undefined, -143), -143);
  assert.equal(parseNumberOption('0', -143), 0);
  assert.equal(parseNumberOption('-63.43', 0), -63.43);
  assert.throws(() => parseNumberOption('abc', -143));
  assert.throws(() => parseNumberOption('', -143)); // --center-lon= (Number('') は 0)
  assert.throws(() => parseNumberOption('true', 0)); // --roll (値の無い指定)
});

test('parseBoolean reads --from-sweep=1 as true and refuses unknown words', () => {
  const { options } = parseArgs(['in.svg', 'out.svg', '--from-sweep=1', '--dry-run']);
  assert.equal(parseBoolean(options['from-sweep'], false), true);
  assert.equal(parseBoolean(options['dry-run'], false), true);
  assert.equal(parseBoolean(undefined, false), false);
  assert.throws(() => parseBoolean('maybe', false));
});
