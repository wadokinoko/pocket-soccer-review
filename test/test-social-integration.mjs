import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\\b[^>]*>([\\s\\S]*?)<\\/script>/gi)].map(m => m[1]).filter(s => s.trim());
assert.ok(scripts.length > 0, 'inline scripts exist');
for (const [i, script] of scripts.entries()) {
  try { new Function(script); }
  catch (e) { throw new Error(`inline script #${i + 1} has a syntax error: ${e.message}`); }
}
const checks = [
  ['match id reset for new matches', /G\\.rankMid=null/],
  ['host creates a match id', /G\\.rankMid=Array\\.from\\(crypto\\.getRandomValues/],
  ['match id is sent to the guest', /mid:G\\.rankMid\\|\\|''/],
  ['guest receives the match id', /G\\.rankMid=\\/\\^\\[0-9a-f\\]\\{16\\}\\/\\.test\\(m\\.mid\\|\\|''\\)/],
  ['host opens a ranked match', /api\\('\\/api\\/match\\/open'/],
  ['both sides report results', /api\\('\\/api\\/match\\/report'/],
  ['ranking report waits for match registration', /api\\('\\/api\\/match\\/'\\+encodeURIComponent\\(d\\.mid\\)\\)/],
  ['match finish event exists', /ps:rank-match-finish/],
];
for (const [label, pattern] of checks) assert.match(html, pattern, label);
console.log(`HTML integration checks passed: ${scripts.length} inline scripts parsed, ${checks.length} integration assertions passed.`);
