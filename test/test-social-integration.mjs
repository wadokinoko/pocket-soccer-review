import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).filter(s => s.trim());
assert.ok(scripts.length > 0, 'inline scripts exist');
for (const [i, script] of scripts.entries()) {
  try { new Function(script); }
  catch (e) { throw new Error(`inline script #${i + 1} has a syntax error: ${e.message}`); }
}
const checks = [
  ['malformed saved auth secret is rejected instead of silently replaced', "if(typeof auth.secret!=='string'||!/^[0-9a-f]{64}$/.test(auth.secret))throw new Error('保存された認証情報が壊れているよ。秘密鍵は復元できないため、既存アカウントには接続できないよ。');"],
  ['match ID resets for new matches', 'G.rankMid=null'],
  ['host creates a match ID', 'G.rankMid=Array.from(crypto.getRandomValues'],
  ['match ID is sent to guest', 'mid:G.rankMid||\'\''],
  ['guest receives the match ID', "G.rankMid=/^[0-9a-f]{16}$/.test(m.mid||'')"],
  ['host opens a ranked match', "api('/api/match/open'"],
  ['both sides report results', "api('/api/match/report'"],
  ['guest waits for match registration', "api('/api/match/'+encodeURIComponent(d.mid))"],
  ['match finish event exists', 'ps:rank-match-finish'],
];
for (const [label, needle] of checks) assert.ok(html.includes(needle), label);
console.log(`HTML integration checks passed: ${scripts.length} inline scripts parsed, ${checks.length} integration assertions passed.`);

const apiSource = readFileSync(new URL('../api-worker.js', import.meta.url), 'utf8');
const contracts = [
  ['frontend match ID format matches API validation', /MID_RE\s*=\s*\/\^\[0-9a-f\]\{16\}\$\//.test(apiSource) && html.includes("/^[0-9a-f]{16}$/.test(G.rankMid")],
  ['game duration options match API allowlist', /const LENS = \[120, 180, 300\]/.test(apiSource) && ['value="120"', 'value="180"', 'value="300"'].every(v => html.includes(v))],
  ['match open payload contains required guest and duration', /body:JSON\.stringify\(\{mid:d\.mid,guest:d\.guestId,len:d\.len\}\)/.test(html)],
  ['reports use canonical host and guest scores', /hostScore:G\.score\[0\],guestScore:G\.score\[1\]/.test(html) && /hs:d\.hostScore,gs:d\.guestScore/.test(html)],
  ['API verifies both players belong to the match', /m\.host !== p\.id && m\.guest !== p\.id/.test(apiSource)],
];
for (const [label, passed] of contracts) assert.ok(passed, label);
console.log(`Cross-file contract checks passed: ${contracts.length} API/frontend assertions.`);
