/**
 * ポケットサッカー: ランキング / プロフィール / フレンド API (Cloudflare Workers + D1)
 *
 * 既存Workerへの取り込み方(/ws の処理には一切触れません):
 *
 *   import { handleApi } from './api-worker.js';
 *   export default {
 *     async fetch(request, env, ctx) {
 *       const api = await handleApi(request, env);   // /api/* 以外は null が返る
 *       if (api) return api;
 *       ...既存の処理(/ws など)...
 *     }
 *   }
 *
 * 必要な設定: D1 バインディング名 `DB` と schema.sql の適用(README.md 参照)。
 * `DB` が無い/未マイグレーションの場合は 503 を返し、架空のデータは一切返しません。
 */

const NAME_MAX = 12, BIO_MAX = 80, AVATARS = 24;
const DEFAULT_NAME = '名無しプレイヤー';
const ID_RE = /^PS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const SECRET_RE = /^[0-9a-f]{64}$/;
const MID_RE = /^[0-9a-f]{16}$/;
const ROOM_RE = /^[A-Za-z0-9]{4,10}$/;
const LENS = [120, 180, 300];
const ONLINE_SEC = 180;          // last_seen がこの秒数以内ならオンライン
const INVITE_TTL = 600;          // 招待の有効期限
const FRIEND_COOLDOWN = 86400;   // 拒否された後の再申請禁止時間
const PAIR_DAILY_CAP = 5;        // 同じ2人の組み合わせでランキングに反映される1日の試合数
const K = 32, BASE_RATING = 1000, MIN_RATING = 100;

const CORS = {
  'Access-Control-Allow-Origin': '*',   // 認証はCookieではなくBearerトークンのため * でも安全
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

class HttpErr extends Error {
  constructor(status, code, msg) { super(msg || code); this.status = status; this.code = code; }
}
const bad = (code, msg) => new HttpErr(400, code, msg);
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const now = () => Math.floor(Date.now() / 1000);

/* ---------- 入力検証 ---------- */
// 制御文字・ゼロ幅文字・双方向制御文字を除去 (表示の乗っ取り防止)
const STRIP = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
function cleanText(v, max, { allowEmpty = false, field = 'text' } = {}) {
  if (typeof v !== 'string') throw bad('invalid_' + field, field + ' must be a string');
  let s = v.normalize('NFC').replace(STRIP, '').replace(/\s+/g, ' ').trim();
  if (/[<>]/.test(s)) throw bad('invalid_' + field, 'HTMLとして解釈される文字(< >)は使えません');
  if (!s && !allowEmpty) throw bad('empty_' + field, field + ' is empty');
  if (Array.from(s).length > max) throw bad('too_long_' + field, field + ' is too long');
  return s;
}
const nameKey = (s) => s.toLowerCase();
const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

async function readBody(request) {
  const t = await request.text();
  if (t.length > 4096) throw new HttpErr(413, 'too_large');
  if (!t) return {};
  let o;
  try { o = JSON.parse(t); } catch (_) { throw bad('invalid_json'); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw bad('invalid_json');
  return o;
}

/* ---------- 認証 ---------- */
async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
/** Authorization: Bearer <PlayerID>.<secret(64hex)>  秘密値はサーバーにはハッシュだけを保存する。 */
async function auth(request, env, optional = false) {
  const m = /^Bearer (PS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})\.([0-9a-f]{64})$/.exec(request.headers.get('Authorization') || '');
  if (!m) { if (optional) return null; throw new HttpErr(401, 'unauthorized'); }
  const row = await env.DB.prepare('SELECT * FROM players WHERE id=?').bind(m[1]).first();
  if (!row || !safeEq(await sha256hex(m[2]), row.secret_hash)) { if (optional) return null; throw new HttpErr(401, 'unauthorized'); }
  return row;
}

/* ---------- レート制限 (D1) ---------- */
async function rateLimit(env, key, limit, windowSec) {
  const t = now();
  await env.DB.prepare(
    'INSERT INTO rl(k,ws,c) VALUES(?,?,1) ON CONFLICT(k) DO UPDATE SET ' +
    'c=CASE WHEN ws<=? THEN 1 ELSE c+1 END, ws=CASE WHEN ws<=? THEN ? ELSE ws END'
  ).bind(key, t, t - windowSec, t - windowSec, t).run();
  const r = await env.DB.prepare('SELECT c FROM rl WHERE k=?').bind(key).first();
  if (r && r.c > limit) throw new HttpErr(429, 'rate_limited', '操作が多すぎます。少し待ってからお試しください');
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM rl WHERE ws<?').bind(t - 90000).run();
}

/* ---------- 出力整形 ---------- */
const pct = (w, g) => (g > 0 ? Math.round((w / g) * 1000) / 10 : 0);
function brief(r) {
  return { id: r.id, name: r.name, avatar: r.avatar, rating: r.rating, games: r.games, online: now() - r.last_seen < ONLINE_SEC };
}
function full(r, rank) {
  return { ...brief(r), bio: r.bio, wins: r.wins, losses: r.losses, draws: r.draws, winRate: pct(r.wins, r.games), rank };
}
/** 順位 = ポイント(rating)降順 → 勝利数降順 → 試合数昇順(少ない方が上) → 登録が早い順 → ID順。試合0のプレイヤーは順位なし。 */
async function rankOf(env, r) {
  if (!r.games) return null;
  const x = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM players WHERE games>0 AND (rating>? OR (rating=? AND wins>?) OR (rating=? AND wins=? AND games<?) ' +
    'OR (rating=? AND wins=? AND games=? AND created_at<?) OR (rating=? AND wins=? AND games=? AND created_at=? AND id<?))'
  ).bind(r.rating, r.rating, r.wins, r.rating, r.wins, r.games, r.rating, r.wins, r.games, r.created_at, r.rating, r.wins, r.games, r.created_at, r.id).first();
  return x.n + 1;
}
const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

/* ---------- ハンドラ ---------- */
async function register(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  await rateLimit(env, 'reg:' + ip, 10, 3600);
  const b = await readBody(request);
  if (!isId(b.id) || typeof b.secret !== 'string' || !SECRET_RE.test(b.secret)) throw bad('invalid_credentials');
  const name = b.name === undefined ? DEFAULT_NAME : cleanText(b.name, NAME_MAX, { field: 'name' });
  const hash = await sha256hex(b.secret);
  const ex = await env.DB.prepare('SELECT * FROM players WHERE id=?').bind(b.id).first();
  if (ex) {
    if (!safeEq(hash, ex.secret_hash)) throw new HttpErr(409, 'id_taken', 'このプレイヤーIDは別の端末で登録済みです');
    return json({ ok: true, created: false, me: full(ex, await rankOf(env, ex)) });
  }
  const t = now();
  await env.DB.prepare('INSERT INTO players(id,secret_hash,name,name_key,avatar,bio,rating,created_at,last_seen,updated_at) VALUES(?,?,?,?,0,\'\',?,?,?,?)')
    .bind(b.id, hash, name, nameKey(name), BASE_RATING, t, t, t).run();
  const row = await env.DB.prepare('SELECT * FROM players WHERE id=?').bind(b.id).first();
  return json({ ok: true, created: true, me: full(row, null) }, 201);
}

async function counts(env, id) {
  const t = now();
  const a = await env.DB.prepare("SELECT COUNT(*) AS n FROM friendships WHERE target=? AND status='pending'").bind(id).first();
  const i = await env.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE to_id=? AND created_at>?').bind(id, t - INVITE_TTL).first();
  return { req: a.n, inv: i.n };
}

async function me(request, env) {
  const p = await auth(request, env);
  return json({ me: full(p, await rankOf(env, p)), ...(await counts(env, p.id)) });
}

async function updateProfile(request, env) {
  const p = await auth(request, env);
  await rateLimit(env, 'prof:' + p.id, 6, 60);
  const b = await readBody(request);
  const name = b.name === undefined ? p.name : cleanText(b.name, NAME_MAX, { field: 'name' });
  const bio = b.bio === undefined ? p.bio : cleanText(b.bio, BIO_MAX, { allowEmpty: true, field: 'bio' });
  const avatar = b.avatar === undefined ? p.avatar : b.avatar;
  if (!intIn(avatar, 0, AVATARS - 1)) throw bad('invalid_avatar');
  await env.DB.prepare('UPDATE players SET name=?,name_key=?,bio=?,avatar=?,updated_at=? WHERE id=?')
    .bind(name, nameKey(name), bio, avatar, now(), p.id).run();
  const row = await env.DB.prepare('SELECT * FROM players WHERE id=?').bind(p.id).first();
  return json({ ok: true, me: full(row, await rankOf(env, row)) });
}

async function ranking(request, env, url) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  await rateLimit(env, 'rk:' + ip, 60, 60);
  const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const offset = Math.max(0, Math.min(10000, parseInt(url.searchParams.get('offset') || '0', 10) || 0));
  const rows = await env.DB.prepare(
    'SELECT * FROM players WHERE games>0 ORDER BY rating DESC, wins DESC, games ASC, created_at ASC, id ASC LIMIT ? OFFSET ?'
  ).bind(limit, offset).all();
  const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM players WHERE games>0').first()).n;
  const list = rows.results.map((r, i) => ({ rank: offset + i + 1, ...full(r, offset + i + 1) }));
  const viewer = await auth(request, env, true);
  const meOut = viewer ? full(viewer, await rankOf(env, viewer)) : null;
  return json({ total, offset, list, me: meOut });
}

const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
async function search(request, env, url) {
  const p = await auth(request, env);
  await rateLimit(env, 'srch:' + p.id, 30, 60);
  let q = cleanText(url.searchParams.get('q') || '', 20, { field: 'q' });
  const up = q.toUpperCase();
  let rows;
  if (ID_RE.test(up)) rows = await env.DB.prepare('SELECT * FROM players WHERE id=? AND id<>?').bind(up, p.id).all();
  else rows = await env.DB.prepare("SELECT * FROM players WHERE name_key LIKE ? ESCAPE '\\' AND id<>? ORDER BY games DESC, created_at ASC LIMIT 20")
    .bind('%' + likeEsc(nameKey(q)) + '%', p.id).all();
  return json({ list: rows.results.map(brief) });
}

async function relation(env, me, other) {
  if (me === other) return 'self';
  const f = await env.DB.prepare('SELECT * FROM friendships WHERE pair=?').bind(pairKey(me, other)).first();
  if (!f) return 'none';
  if (f.status === 'accepted') return 'friend';
  if (f.status === 'pending') return f.requester === me ? 'sent' : 'received';
  return f.requester === me ? 'rejected' : 'none';
}

async function playerProfile(request, env, id) {
  const p = await auth(request, env);
  await rateLimit(env, 'get:' + p.id, 120, 60);
  if (!isId(id)) throw bad('invalid_id');
  const r = await env.DB.prepare('SELECT * FROM players WHERE id=?').bind(id).first();
  if (!r) throw new HttpErr(404, 'not_found');
  const ms = await env.DB.prepare(
    "SELECT m.*, h.name AS hn, g.name AS gn FROM matches m JOIN players h ON h.id=m.host JOIN players g ON g.id=m.guest " +
    "WHERE (m.host=? OR m.guest=?) AND m.status='done' ORDER BY m.done_at DESC LIMIT 10"
  ).bind(id, id).all();
  const recent = ms.results.map((m) => {
    const isHost = m.host === id;
    const my = isHost ? m.hs : m.gs, th = isHost ? m.gs : m.hs;
    return {
      opp: { id: isHost ? m.guest : m.host, name: isHost ? m.gn : m.hn },
      my, their: th, result: my > th ? 'win' : my < th ? 'loss' : 'draw',
      delta: isHost ? m.dh : m.dg, at: m.done_at,
    };
  });
  return json({ player: full(r, await rankOf(env, r)), recent, relation: await relation(env, p.id, id) });
}

/* ---------- フレンド ---------- */
async function friendRequest(request, env) {
  const p = await auth(request, env);
  await rateLimit(env, 'frq:' + p.id, 10, 60);
  await rateLimit(env, 'frd:' + p.id, 40, 86400);
  const b = await readBody(request);
  if (!isId(b.to)) throw bad('invalid_id');
  if (b.to === p.id) throw bad('self_request', '自分自身には申請できません');
  const t = await env.DB.prepare('SELECT id FROM players WHERE id=?').bind(b.to).first();
  if (!t) throw new HttpErr(404, 'not_found', '相手が見つかりません');
  const pair = pairKey(p.id, b.to), n = now();
  const f = await env.DB.prepare('SELECT * FROM friendships WHERE pair=?').bind(pair).first();
  if (!f) {
    await env.DB.prepare("INSERT INTO friendships(pair,requester,target,status,created_at,updated_at) VALUES(?,?,?,'pending',?,?)").bind(pair, p.id, b.to, n, n).run();
    return json({ ok: true, status: 'sent' });
  }
  if (f.status === 'accepted') throw new HttpErr(409, 'already_friends', 'すでにフレンドです');
  if (f.status === 'pending') {
    if (f.requester === p.id) throw new HttpErr(409, 'already_requested', 'すでに申請済みです');
    await env.DB.prepare("UPDATE friendships SET status='accepted',updated_at=? WHERE pair=?").bind(n, pair).run();   // 相手からの申請が先にあれば成立
    return json({ ok: true, status: 'friend' });
  }
  // rejected
  if (f.requester === p.id && n - f.updated_at < FRIEND_COOLDOWN) throw new HttpErr(429, 'cooldown', '拒否されたため、しばらく再申請できません');
  await env.DB.prepare("UPDATE friendships SET requester=?,target=?,status='pending',created_at=?,updated_at=? WHERE pair=?").bind(p.id, b.to, n, n, pair).run();
  return json({ ok: true, status: 'sent' });
}

async function friendRespond(request, env) {
  const p = await auth(request, env);
  await rateLimit(env, 'frr:' + p.id, 30, 60);
  const b = await readBody(request);
  if (!isId(b.from) || typeof b.accept !== 'boolean') throw bad('invalid_request');
  const r = await env.DB.prepare("UPDATE friendships SET status=?,updated_at=? WHERE pair=? AND requester=? AND target=? AND status='pending'")
    .bind(b.accept ? 'accepted' : 'rejected', now(), pairKey(p.id, b.from), b.from, p.id).run();
  if (!r.meta.changes) throw new HttpErr(404, 'not_found', '該当する申請がありません');
  return json({ ok: true, status: b.accept ? 'friend' : 'rejected' });
}

async function friendRemove(request, env) {
  const p = await auth(request, env);
  await rateLimit(env, 'frm:' + p.id, 30, 60);
  const b = await readBody(request);
  if (!isId(b.id)) throw bad('invalid_id');
  const r = await env.DB.prepare("DELETE FROM friendships WHERE pair=? AND (status='accepted' OR (status='pending' AND requester=?))")
    .bind(pairKey(p.id, b.id), p.id).run();
  if (!r.meta.changes) throw new HttpErr(404, 'not_found');
  await env.DB.prepare('DELETE FROM invites WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)').bind(p.id, b.id, b.id, p.id).run();
  return json({ ok: true });
}

async function friends(request, env) {
  const p = await auth(request, env);
  await rateLimit(env, 'frl:' + p.id, 60, 60);
  const t = now();
  const rows = await env.DB.prepare(
    'SELECT f.*, o.id AS oid, o.name, o.avatar, o.rating, o.games, o.last_seen FROM friendships f ' +
    'JOIN players o ON o.id = CASE WHEN f.requester=? THEN f.target ELSE f.requester END WHERE f.requester=? OR f.target=? ORDER BY f.updated_at DESC LIMIT 300'
  ).bind(p.id, p.id, p.id).all();
  const O = (r) => brief({ id: r.oid, name: r.name, avatar: r.avatar, rating: r.rating, games: r.games, last_seen: r.last_seen });
  const out = { friends: [], incoming: [], outgoing: [] };
  for (const r of rows.results) {
    if (r.status === 'accepted') out.friends.push(O(r));
    else if (r.status === 'pending' && r.target === p.id) out.incoming.push({ ...O(r), at: r.created_at });
    else if (r.requester === p.id) out.outgoing.push({ ...O(r), status: r.status, at: r.updated_at });
  }
  const inv = await env.DB.prepare(
    'SELECT i.id, i.room, i.created_at, o.id AS oid, o.name FROM invites i JOIN players o ON o.id=i.from_id WHERE i.to_id=? AND i.created_at>? ORDER BY i.created_at DESC LIMIT 10'
  ).bind(p.id, t - INVITE_TTL).all();
  out.invites = inv.results.map((i) => ({ id: i.id, room: i.room, at: i.created_at, from: { id: i.oid, name: i.name } }));
  return json(out);
}

async function ping(request, env) {
  const p = await auth(request, env);
  await rateLimit(env, 'ping:' + p.id, 8, 60);
  await env.DB.prepare('UPDATE players SET last_seen=? WHERE id=?').bind(now(), p.id).run();
  return json({ ok: true, ...(await counts(env, p.id)) });
}

async function invite(request, env) {
  const p = await auth(request, env);
  await rateLimit(env, 'inv:' + p.id, 10, 60);
  const b = await readBody(request);
  if (!isId(b.to) || typeof b.room !== 'string' || !ROOM_RE.test(b.room)) throw bad('invalid_request');
  const f = await env.DB.prepare("SELECT 1 AS x FROM friendships WHERE pair=? AND status='accepted'").bind(pairKey(p.id, b.to)).first();
  if (!f) throw new HttpErr(403, 'not_friends', 'フレンドではありません');
  await env.DB.prepare('DELETE FROM invites WHERE from_id=? AND to_id=?').bind(p.id, b.to).run();
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => x.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare('INSERT INTO invites(id,from_id,to_id,room,created_at) VALUES(?,?,?,?,?)').bind(id, p.id, b.to, b.room, now()).run();
  return json({ ok: true });
}

async function inviteDismiss(request, env) {
  const p = await auth(request, env);
  const b = await readBody(request);
  if (typeof b.id !== 'string' || !/^[0-9a-f]{16}$/.test(b.id)) throw bad('invalid_request');
  await env.DB.prepare('DELETE FROM invites WHERE id=? AND to_id=?').bind(b.id, p.id).run();
  return json({ ok: true });
}

/* ---------- 試合結果 ---------- *
 * 1) ホストが試合開始を登録(open)。2) ホストとゲストの両方が結果を報告(report)。
 * 3) 両者の報告が一致し、経過時間が妥当なときだけサーバーがEloを計算して1回だけ反映する。
 * クライアントが送るのは「スコア」だけで、ポイント・勝敗数はサーバーが決める。 */
async function matchOpen(request, env) {
  const p = await auth(request, env);
  await rateLimit(env, 'mo:' + p.id, 10, 60);
  const b = await readBody(request);
  if (typeof b.mid !== 'string' || !MID_RE.test(b.mid) || !isId(b.guest) || !LENS.includes(b.len)) throw bad('invalid_request');
  if (b.guest === p.id) throw bad('self_match');
  const g = await env.DB.prepare('SELECT id FROM players WHERE id=?').bind(b.guest).first();
  if (!g) throw new HttpErr(404, 'guest_not_registered', '相手がランキングに未登録です');
  const ex = await env.DB.prepare('SELECT host FROM matches WHERE mid=?').bind(b.mid).first();
  if (ex) {
    if (ex.host === p.id) return json({ ok: true, existing: true });
    throw new HttpErr(409, 'mid_taken');
  }
  if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM matches WHERE status='open' AND opened_at<?").bind(now() - 7200).run();
  await env.DB.prepare("INSERT INTO matches(mid,host,guest,len,status,opened_at) VALUES(?,?,?,?, 'open', ?)").bind(b.mid, p.id, b.guest, b.len, now()).run();
  return json({ ok: true });
}

function eloDelta(ra, rb, score) {
  const e = 1 / (1 + Math.pow(10, (rb - ra) / 400));
  return Math.round(K * (score - e));
}

async function matchReport(request, env) {
  const p = await auth(request, env);
  await rateLimit(env, 'mr:' + p.id, 20, 60);
  const b = await readBody(request);
  if (typeof b.mid !== 'string' || !MID_RE.test(b.mid) || !intIn(b.hs, 0, 30) || !intIn(b.gs, 0, 30)) throw bad('invalid_request');
  const m = await env.DB.prepare('SELECT * FROM matches WHERE mid=?').bind(b.mid).first();
  if (!m || (m.host !== p.id && m.guest !== p.id)) throw new HttpErr(404, 'not_found');
  if (m.status !== 'open') return json(await matchStatusOf(env, m, p.id));
  const el = now() - m.opened_at;
  if (el < Math.floor(m.len * 0.8)) throw new HttpErr(422, 'too_early', '試合時間が足りないため記録できません');
  if (el > m.len * 6 + 600) throw new HttpErr(422, 'too_late', '報告の期限を過ぎています');
  await env.DB.prepare('INSERT OR IGNORE INTO reports(mid,pid,hs,gs,at) VALUES(?,?,?,?,?)').bind(b.mid, p.id, b.hs, b.gs, now()).run();
  const rs = await env.DB.prepare('SELECT * FROM reports WHERE mid=?').bind(b.mid).all();
  const mine = rs.results.find((r) => r.pid === p.id);
  if (mine.hs !== b.hs || mine.gs !== b.gs) throw new HttpErr(409, 'already_reported', '報告済みの結果と異なります');
  if (rs.results.length < 2) return json({ status: 'waiting' });
  const [r1, r2] = rs.results;
  if (r1.hs !== r2.hs || r1.gs !== r2.gs) {
    await env.DB.prepare("UPDATE matches SET status='disputed',done_at=? WHERE mid=? AND status='open'").bind(now(), b.mid).run();
    return json({ status: 'disputed' });
  }
  return json(await finalize(env, m, r1.hs, r1.gs, p.id));
}

async function finalize(env, m, hs, gs, viewer) {
  const t = now();
  const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM matches WHERE pair=? AND status='done' AND done_at>?").bind(pairKey(m.host, m.guest), t - 86400).first().catch(() => null);
  const capped = cnt ? cnt.n >= PAIR_DAILY_CAP : false;
  // 二重登録防止: status='open' のものだけを1回だけ確定させる
  const claim = await env.DB.prepare('UPDATE matches SET status=?,hs=?,gs=?,done_at=?,pair=? WHERE mid=? AND status=\'open\'')
    .bind(capped ? 'capped' : 'done', hs, gs, t, pairKey(m.host, m.guest), m.mid).run();
  const fresh = await env.DB.prepare('SELECT * FROM matches WHERE mid=?').bind(m.mid).first();
  if (!claim.meta.changes || capped) return matchStatusOf(env, fresh, viewer);
  const H = await env.DB.prepare('SELECT rating FROM players WHERE id=?').bind(m.host).first();
  const G = await env.DB.prepare('SELECT rating FROM players WHERE id=?').bind(m.guest).first();
  const sh = hs > gs ? 1 : hs < gs ? 0 : 0.5;
  const dh = eloDelta(H.rating, G.rating, sh), dg = eloDelta(G.rating, H.rating, 1 - sh);
  const upd = 'UPDATE players SET rating=MAX(?,rating+?),wins=wins+?,losses=losses+?,draws=draws+?,games=games+1,updated_at=? WHERE id=?';
  await env.DB.batch([
    env.DB.prepare(upd).bind(MIN_RATING, dh, sh === 1 ? 1 : 0, sh === 0 ? 1 : 0, sh === 0.5 ? 1 : 0, t, m.host),
    env.DB.prepare(upd).bind(MIN_RATING, dg, sh === 0 ? 1 : 0, sh === 1 ? 1 : 0, sh === 0.5 ? 1 : 0, t, m.guest),
    env.DB.prepare('UPDATE matches SET dh=?,dg=? WHERE mid=?').bind(dh, dg, m.mid),
  ]);
  return matchStatusOf(env, await env.DB.prepare('SELECT * FROM matches WHERE mid=?').bind(m.mid).first(), viewer);
}

async function matchStatusOf(env, m, viewer) {
  if (m.status === 'done') {
    const mineHost = m.host === viewer;
    const r = await env.DB.prepare('SELECT * FROM players WHERE id=?').bind(viewer).first();
    return { status: 'done', delta: mineHost ? m.dh : m.dg, rating: r.rating, rank: await rankOf(env, r) };
  }
  return { status: m.status === 'open' ? 'waiting' : m.status };   // waiting | disputed | capped
}

async function matchGet(request, env, mid) {
  const p = await auth(request, env);
  await rateLimit(env, 'mg:' + p.id, 30, 60);
  if (!MID_RE.test(mid)) throw bad('invalid_id');
  const m = await env.DB.prepare('SELECT * FROM matches WHERE mid=?').bind(mid).first();
  if (!m || (m.host !== p.id && m.guest !== p.id)) throw new HttpErr(404, 'not_found');
  return json(await matchStatusOf(env, m, p.id));
}

/* ---------- ルーター ---------- */
export async function handleApi(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    if (!env || !env.DB) throw new HttpErr(503, 'storage_unavailable', 'ランキング用の保存先(D1)が未設定です');
    const path = url.pathname, M = request.method;
    const post = (p, fn) => M === 'POST' && path === p ? fn(request, env) : null;
    let res =
      post('/api/register', register) || post('/api/profile', updateProfile) || post('/api/ping', ping) ||
      post('/api/friend/request', friendRequest) || post('/api/friend/respond', friendRespond) || post('/api/friend/remove', friendRemove) ||
      post('/api/invite', invite) || post('/api/invite/dismiss', inviteDismiss) ||
      post('/api/match/open', matchOpen) || post('/api/match/report', matchReport);
    if (!res && M === 'GET') {
      let m;
      if (path === '/api/me') res = me(request, env);
      else if (path === '/api/ranking') res = ranking(request, env, url);
      else if (path === '/api/search') res = search(request, env, url);
      else if (path === '/api/friends') res = friends(request, env);
      else if ((m = /^\/api\/player\/([^/]+)$/.exec(path))) res = playerProfile(request, env, decodeURIComponent(m[1]));
      else if ((m = /^\/api\/match\/([^/]+)$/.exec(path))) res = matchGet(request, env, decodeURIComponent(m[1]));
    }
    if (!res) throw new HttpErr(404, 'not_found');
    return await res;
  } catch (e) {
    if (e instanceof HttpErr) return json({ error: e.code, message: e.message }, e.status);
    const msg = String((e && e.message) || e);
    if (/no such table|no such column/i.test(msg)) return json({ error: 'schema_missing', message: 'D1のマイグレーション(schema.sql)が未適用です' }, 503);
    console.error('api error', msg);
    return json({ error: 'internal', message: 'サーバーエラー' }, 500);
  }
}
