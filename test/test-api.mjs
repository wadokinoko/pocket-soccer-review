import { readFileSync } from 'node:fs';
import { handleApi } from '../api-worker.js';
import { makeD1 } from './d1shim.mjs';
const env = { DB: makeD1(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')) };
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const mkId = () => 'PS-' + Array.from({ length: 4 }, () => A[Math.random() * 32 | 0]).join('') + '-' + Array.from({ length: 4 }, () => A[Math.random() * 32 | 0]).join('');
async function call(method, path, body, who, extra = {}) {
  const h = { 'Content-Type': 'application/json', 'CF-Connecting-IP': extra.ip || '1.1.1.' + (Math.random() * 200 | 0), ...(who ? { Authorization: `Bearer ${who.id}.${who.secret}` } : {}) };
  const r = await handleApi(new Request('https://x.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
  return { s: r.status, j: await r.json() };
}
const mk = async (name) => { const u = { id: mkId(), secret: hex(32) }; const r = await call('POST', '/api/register', { ...u, name }); u.r = r; return u; };

console.log('# 1 register / auth');
const a = await mk('アリス'), b = await mk('ボブ'), c = await mk('チャーリー');
ok(a.r.s === 201 && a.r.j.me.rating === 1000, 'register 201');
ok((await call('POST', '/api/register', { id: a.id, secret: a.secret, name: 'x' })).s === 200, 'idempotent re-register with same secret');
ok((await call('POST', '/api/register', { id: a.id, secret: hex(32), name: 'evil' })).s === 409, 'registering an existing id with another secret → 409');
ok((await call('GET', '/api/me', null, { id: a.id, secret: hex(32) })).s === 401, 'wrong secret → 401');
ok((await call('GET', '/api/me', null, null)).s === 401, 'no auth → 401');
ok((await call('GET', '/api/me', null, a)).j.me.name === 'アリス', 'me');

const rlReset=()=>env.DB._raw.exec('DELETE FROM rl');
console.log('# 2 name / profile validation');
for (const n of ['', '   ', 'a'.repeat(13), '<script>alert(1)</script>', 123, null]) ok((await call('POST', '/api/profile', { name: n }, a)).s === 400, 'reject name ' + JSON.stringify(n));
rlReset();
ok((await call('POST', '/api/profile', { name: '\u202Eevil\u200B' }, a)).j.me.name === 'evil', 'bidi/zero-width stripped');
ok((await call('POST', '/api/profile', { name: '日本語の名前12文字だよ', bio: 'こんにちは', avatar: 5 }, a)).s === 200, 'valid update');
ok((await call('POST', '/api/profile', { avatar: 99 }, a)).s === 400, 'avatar range');
ok((await call('POST', '/api/profile', { bio: 'x'.repeat(81) }, a)).s === 400, 'bio length');
rlReset();
const dup = await mk('日本語の名前12文字だよ'); ok(dup.r.s === 201, 'duplicate names allowed (identity = id)');
rlReset();await call('POST', '/api/profile', { name: 'アリス' }, a);
console.log('# 3 only owner can edit');
const evil = await mk('悪者');
await call('POST', '/api/profile', { name: 'hacked', id: a.id }, evil);
ok((await call('GET', '/api/me', null, a)).j.me.name === 'アリス', 'other player cannot change my name');
rlReset();
console.log('# 4 rate limit');
let last; for (let i = 0; i < 8; i++) last = await call('POST', '/api/profile', { bio: 'r' + i }, evil);
ok(last.s === 429, 'profile update rate-limited (' + last.s + ')');
let regs = []; for (let i = 0; i < 12; i++) regs.push((await call('POST', '/api/register', { id: mkId(), secret: hex(32), name: 'n' }, null, { ip: '9.9.9.9' })).s);
ok(regs.includes(429), 'register per-IP limit');

console.log('# 5 ranking empty / storage');
let rk = await call('GET', '/api/ranking'); ok(rk.s === 200 && rk.j.total === 0 && rk.j.list.length === 0, 'ranking empty before any match (no dummy data)');
ok((await handleApi(new Request('https://x.test/api/ranking'), {})).status === 503, 'no DB → 503');
ok((await handleApi(new Request('https://x.test/ws'), env)) === null, '/ws is not handled by api module');

console.log('# 6 match flow');
const mid = hex(8);
await new Promise(r => setTimeout(r, 0));
ok((await call('POST', '/api/match/open', { mid, guest: b.id, len: 120 }, a)).s === 200, 'open');
ok((await call('POST', '/api/match/report', { mid, hs: 3, gs: 1 }, a)).s === 422, 'report too early rejected');
env.DB._raw.exec(`UPDATE matches SET opened_at=opened_at-200 WHERE mid='${mid}'`);   // 時間経過のシミュレーション
ok((await call('POST', '/api/match/report', { mid, hs: 3, gs: 1 }, c)).s === 404, 'non-participant cannot report');
const r1 = await call('POST', '/api/match/report', { mid, hs: 3, gs: 1 }, a); ok(r1.j.status === 'waiting', 'first report waits');
ok((await call('POST', '/api/match/report', { mid, hs: 9, gs: 0 }, a)).s === 409, 'cannot change own report');
const r2 = await call('POST', '/api/match/report', { mid, hs: 3, gs: 1 }, b); ok(r2.j.status === 'done' && r2.j.delta === -16, 'second matching report finalizes: ' + JSON.stringify(r2.j));
const r3 = await call('POST', '/api/match/report', { mid, hs: 3, gs: 1 }, b); ok(r3.j.status === 'done', 'repeat report is idempotent');
const ga = (await call('GET', '/api/me', null, a)).j.me, gb = (await call('GET', '/api/me', null, b)).j.me;
ok(ga.rating === 1016 && ga.wins === 1 && ga.games === 1 && gb.rating === 984 && gb.losses === 1 && gb.games === 1, 'ratings applied exactly once ' + ga.rating + '/' + gb.rating);
ok((await call('GET', '/api/match/' + mid, null, a)).j.delta === 16, 'poll result for first reporter');
ok((await call('POST', '/api/match/open', { mid, guest: b.id, len: 120 }, evil)).s === 409, 'mid cannot be hijacked');
// mismatch
const mid2 = hex(8); await call('POST', '/api/match/open', { mid: mid2, guest: b.id, len: 120 }, a);
env.DB._raw.exec(`UPDATE matches SET opened_at=opened_at-200 WHERE mid='${mid2}'`);
await call('POST', '/api/match/report', { mid: mid2, hs: 9, gs: 0 }, a);
ok((await call('POST', '/api/match/report', { mid: mid2, hs: 0, gs: 2 }, b)).j.status === 'disputed', 'mismatching reports → disputed, no points');
ok((await call('GET', '/api/me', null, a)).j.me.games === 1, 'disputed match not counted');
// transaction rollback / retry after a failed stats update
const midFail = hex(8);
await call('POST', '/api/match/open', { mid: midFail, guest: b.id, len: 120 }, a);
env.DB._raw.exec(`UPDATE matches SET opened_at=opened_at-200 WHERE mid='${midFail}'`);
await call('POST', '/api/match/report', { mid: midFail, hs: 2, gs: 0 }, a);
env.DB._raw.exec(`CREATE TRIGGER fail_guest_stats BEFORE UPDATE ON players WHEN OLD.id='${b.id}' AND NEW.games > OLD.games BEGIN SELECT RAISE(ABORT, 'forced test failure'); END`);
const failedFinalize = await call('POST', '/api/match/report', { mid: midFail, hs: 2, gs: 0 }, b);
ok(failedFinalize.s === 500, 'forced stats failure surfaces as server error');
ok((await call('GET', '/api/match/' + midFail, null, a)).j.status === 'waiting', 'failed transaction rolls match status back');
ok((await call('GET', '/api/me', null, a)).j.me.games === 1, 'failed transaction rolls player stats back');
env.DB._raw.exec('DROP TRIGGER fail_guest_stats');
const retryFinalize = await call('POST', '/api/match/report', { mid: midFail, hs: 2, gs: 0 }, b);
ok(retryFinalize.j.status === 'done', 'retry finalizes after transient failure');
ok((await call('GET', '/api/me', null, a)).j.me.games === 2, 'retry applies player stats exactly once');

// guest unregistered / invalid
ok((await call('POST', '/api/match/open', { mid: hex(8), guest: mkId(), len: 120 }, a)).s === 404, 'unregistered guest rejected');
ok((await call('POST', '/api/match/report', { mid, hs: 99, gs: 0 }, a)).s === 400, 'score range');
// daily pair cap
let capped = 0; for (let i = 0; i < 7; i++) {
  const m = hex(8); await call('POST', '/api/match/open', { mid: m, guest: b.id, len: 120 }, a);
  env.DB._raw.exec(`UPDATE matches SET opened_at=opened_at-200 WHERE mid='${m}'`);
  env.DB._raw.exec(`DELETE FROM rl`);
  await call('POST', '/api/match/report', { mid: m, hs: 1, gs: 0 }, a); const r = await call('POST', '/api/match/report', { mid: m, hs: 1, gs: 0 }, b);
  if (r.j.status === 'capped') capped++;
}
ok(capped >= 2, 'same pair capped after 5 rated matches/day (capped=' + capped + ')');

console.log('# 7 ranking order / tiebreak / rank');
env.DB._raw.exec('DELETE FROM rl');
env.DB._raw.exec(`UPDATE players SET rating=1200,wins=5,games=6 WHERE id='${a.id}'`);
env.DB._raw.exec(`UPDATE players SET rating=1200,wins=5,games=5 WHERE id='${b.id}'`);
env.DB._raw.exec(`UPDATE players SET rating=1300,wins=1,games=1 WHERE id='${c.id}'`);
rk = await call('GET', '/api/ranking', null, a);
ok(rk.j.list.map(x => x.id).slice(0, 3).join() === [c.id, b.id, a.id].join(), 'order rating → wins → fewer games');
ok(rk.j.me.rank === 3 && rk.j.list[0].winRate === 100, 'my rank = 3, win rate');

console.log('# 8 search / profile');
env.DB._raw.exec('DELETE FROM rl');
const s1 = await call('GET', '/api/search?q=' + encodeURIComponent('ボ'), null, a); ok(s1.j.list.some(x => x.id === b.id), 'search by name');
ok((await call('GET', '/api/search?q=' + b.id.toLowerCase(), null, a)).j.list[0].id === b.id, 'search by id (case-insens)');
ok((await call('GET', '/api/search?q=%25', null, a)).j.list.length === 0, 'LIKE wildcard escaped');
ok((await call('GET', '/api/search?q=x', null, null)).s === 401, 'search needs auth');
const pp = await call('GET', '/api/player/' + b.id, null, a); ok(pp.j.player.id === b.id && pp.j.recent.length >= 1 && pp.j.relation === 'none', 'player profile + recent matches');
ok(!('secret_hash' in pp.j.player), 'no secret in output');
ok((await call('GET', '/api/player/NOPE', null, a)).s === 400, 'bad id');

console.log('# 9 friends');
env.DB._raw.exec('DELETE FROM rl');
ok((await call('POST', '/api/friend/request', { to: a.id }, a)).s === 400, 'self request blocked');
ok((await call('POST', '/api/friend/request', { to: mkId() }, a)).s === 404, 'unknown player');
ok((await call('POST', '/api/friend/request', { to: b.id }, a)).j.status === 'sent', 'request sent');
ok((await call('POST', '/api/friend/request', { to: b.id }, a)).s === 409, 'duplicate request blocked');
ok((await call('GET', '/api/player/' + b.id, null, a)).j.relation === 'sent' && (await call('GET', '/api/player/' + a.id, null, b)).j.relation === 'received', 'relation states');
ok((await call('POST', '/api/friend/respond', { from: a.id, accept: true }, c)).s === 404, 'third party cannot respond');
ok((await call('POST', '/api/friend/respond', { from: b.id, accept: true }, a)).s === 404, 'requester cannot self-accept');
let fl = await call('GET', '/api/friends', null, b); ok(fl.j.incoming.length === 1 && fl.j.incoming[0].id === a.id, 'incoming listed');
ok((await call('POST', '/api/friend/respond', { from: a.id, accept: true }, b)).j.status === 'friend', 'accepted');
ok((await call('POST', '/api/friend/request', { to: a.id }, b)).s === 409, 'already friends');
fl = await call('GET', '/api/friends', null, a); ok(fl.j.friends.length === 1 && fl.j.friends[0].id === b.id, 'friend list');
ok((await call('POST', '/api/ping', {}, b)).s === 200 && (await call('GET', '/api/friends', null, a)).j.friends[0].online === true, 'online status via ping');
// reject + cooldown
ok((await call('POST', '/api/friend/request', { to: c.id }, a)).j.status === 'sent', 'req to c');
ok((await call('POST', '/api/friend/respond', { from: a.id, accept: false }, c)).j.status === 'rejected', 'rejected');
ok((await call('POST', '/api/friend/request', { to: c.id }, a)).s === 429, 're-request blocked during cooldown');
ok((await call('GET', '/api/friends', null, a)).j.outgoing.some(o => o.id === c.id && o.status === 'rejected'), 'rejected status visible to requester');
// cross request auto-accept
const d = await mk('デイブ'), e = await mk('イブ');
await call('POST', '/api/friend/request', { to: e.id }, d);
ok((await call('POST', '/api/friend/request', { to: d.id }, e)).j.status === 'friend', 'crossed requests become friends');
// invites
ok((await call('POST', '/api/invite', { to: c.id, room: 'ABC123' }, a)).s === 403, 'invite only to friends');
ok((await call('POST', '/api/invite', { to: b.id, room: 'bad room!' }, a)).s === 400, 'invite room validated');
ok((await call('POST', '/api/invite', { to: b.id, room: 'ABC123' }, a)).s === 200, 'invite sent');
fl = await call('GET', '/api/friends', null, b); ok(fl.j.invites.length === 1 && fl.j.invites[0].room === 'ABC123' && fl.j.invites[0].from.id === a.id, 'invite received');
ok((await call('POST', '/api/invite/dismiss', { id: fl.j.invites[0].id }, a)).s === 200 && (await call('GET', '/api/friends', null, b)).j.invites.length === 1, 'others cannot dismiss my invite');
await call('POST', '/api/invite/dismiss', { id: fl.j.invites[0].id }, b); ok((await call('GET', '/api/friends', null, b)).j.invites.length === 0, 'dismissed');
ok((await call('POST', '/api/friend/remove', { id: b.id }, a)).s === 200 && (await call('GET', '/api/friends', null, a)).j.friends.length === 0, 'remove friend');
ok((await call('POST', '/api/friend/remove', { id: b.id }, a)).s === 404, 'remove again 404');
console.log('# 10 malformed input');
ok((await handleApi(new Request('https://x.test/api/profile', { method: 'POST', headers: { Authorization: `Bearer ${a.id}.${a.secret}` }, body: '{bad' }), env)).status === 400, 'bad json');
ok((await handleApi(new Request('https://x.test/api/profile', { method: 'POST', headers: { Authorization: `Bearer ${a.id}.${a.secret}` }, body: 'x'.repeat(5000) }), env)).status === 413, 'body too large');
ok((await handleApi(new Request('https://x.test/api/nope'), env)).status === 404, 'unknown route');
ok((await handleApi(new Request('https://x.test/api/ranking', { method: 'OPTIONS' }), env)).status === 204, 'CORS preflight');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
