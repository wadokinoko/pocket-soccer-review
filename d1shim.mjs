// D1 互換の最小ラッパー (node:sqlite 上)。ローカルテスト専用 — 本物のD1/workerdの代わりにはなりません。
import { DatabaseSync } from 'node:sqlite';
export function makeD1(schemaSql) {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  const mk = (sql, params = []) => ({
    bind: (...p) => mk(sql, p),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    _run: () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
  });
  return {
    prepare: (sql) => mk(sql),
    batch: async (stmts) => { db.exec('BEGIN'); try { const o = stmts.map((s) => s._run()); db.exec('COMMIT'); return o; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    _raw: db,
  };
}
