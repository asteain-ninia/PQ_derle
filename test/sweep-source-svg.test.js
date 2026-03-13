import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { prepareSweepSourceSvg } from '../src/sweep-source-svg.js';

test('prepareSweepSourceSvg injects a sweep-only visibility filter', () => {
  const svgText = `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
    <g id="_経緯線"><line x1="0" y1="0" x2="10" y2="10" /></g>
    <g id="_境界"><path d="M0 0L10 10" /></g>
    <g id="_文字"><text x="5" y="5">label</text></g>
  </svg>`;

  const prepared = prepareSweepSourceSvg(svgText, { DOMParser, XMLSerializer });
  const document = new DOMParser().parseFromString(prepared, 'image/svg+xml');
  const styles = Array.from(document.getElementsByTagName('style'));
  const filterStyle = styles.find((node) => node.getAttribute('data-pq-sweep-filter') === '1');

  assert.ok(filterStyle);
  const cssText = filterStyle.textContent || '';
  assert.match(cssText, /#_経緯線/);
  assert.match(cssText, /#_文字/);
  assert.match(cssText, /#_境界/);
  assert.match(cssText, /text,\s*tspan/);
  assert.match(cssText, /stroke:\s*none\s*!important/);
});
