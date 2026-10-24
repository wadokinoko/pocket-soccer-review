-- ポケットサッカー ランキング/プロフィール/フレンド用スキーマ (Cloudflare D1 / SQLite)
CREATE TABLE IF NOT EXISTS players(
  id          TEXT PRIMARY KEY,              -- PS-XXXX-XXXX (端末で生成。本人確認は secret_hash)
  secret_hash TEXT NOT NULL,                 -- 端末だけが持つ秘密値の SHA-256 (秘密値そのものは保存しない)
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL,                 -- 検索用(小文字化)。名前は重複可、識別はIDで行う
  avatar      INTEGER NOT NULL DEFAULT 0,
  bio         TEXT NOT NULL DEFAULT '',
  rating      INTEGER NOT NULL DEFAULT 1000, -- ランキングのポイント(Elo)
  wins        INTEGER NOT NULL DEFAULT 0,
  losses      INTEGER NOT NULL DEFAULT 0,
  draws       INTEGER NOT NULL DEFAULT 0,
  games       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rank ON players(rating DESC, wins DESC, games ASC, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_name ON players(name_key);

CREATE TABLE IF NOT EXISTS friendships(
  pair       TEXT PRIMARY KEY,               -- 小さい方のID|大きい方のID (重複申請・逆方向の二重申請を防ぐ)
  requester  TEXT NOT NULL,
  target     TEXT NOT NULL,
  status     TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fr_req ON friendships(requester);
CREATE INDEX IF NOT EXISTS idx_fr_tgt ON friendships(target, status);

CREATE TABLE IF NOT EXISTS matches(
  mid       TEXT PRIMARY KEY,                -- ホストが発行した試合ID (主キーなので二重登録されない)
  host      TEXT NOT NULL,
  guest     TEXT NOT NULL,
  len       INTEGER NOT NULL,
  status    TEXT NOT NULL,                   -- open | done | disputed | capped
  hs        INTEGER, gs INTEGER,
  dh        INTEGER, dg INTEGER,             -- 各自のポイント増減
  pair      TEXT,
  opened_at INTEGER NOT NULL,
  done_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_m_host ON matches(host, done_at);
CREATE INDEX IF NOT EXISTS idx_m_guest ON matches(guest, done_at);
CREATE INDEX IF NOT EXISTS idx_m_pair ON matches(pair, done_at);

CREATE TABLE IF NOT EXISTS reports(
  mid TEXT NOT NULL, pid TEXT NOT NULL, hs INTEGER NOT NULL, gs INTEGER NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY(mid, pid)
);

CREATE TABLE IF NOT EXISTS invites(
  id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, room TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inv_to ON invites(to_id, created_at);

CREATE TABLE IF NOT EXISTS rl(k TEXT PRIMARY KEY, ws INTEGER NOT NULL, c INTEGER NOT NULL);
