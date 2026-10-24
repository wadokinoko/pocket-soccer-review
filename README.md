# ランキング・プロフィール・フレンド API(Cloudflare Workers + D1)

## 構成
- `api-worker.js` … `/api/*` だけを処理するモジュール(`handleApi(request, env)`)。`/ws`(対戦中継・ランダムマッチ)には触れません。
- `schema.sql` … D1 のテーブル定義(マイグレーション)。
- `test/` … ローカルテスト(`node --no-warnings test/test-api.mjs`、Node 22 以上)。

## デプロイ手順
1. D1 を作成: `npx wrangler d1 create pocket-soccer-db` → 表示された `database_id` を控える。
2. 既存の `wrangler.toml` に追記:
   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "pocket-soccer-db"
   database_id = "(手順1の値)"
   ```
3. スキーマ適用: `npx wrangler d1 execute pocket-soccer-db --remote --file=./schema.sql`
4. 既存Workerの `fetch` の先頭に追加(既存処理は変更しない):
   ```js
   import { handleApi } from './api-worker.js';
   // fetch(request, env, ctx) の先頭で
   const api = await handleApi(request, env);
   if (api) return api;
   ```
5. `npx wrangler deploy`
6. 確認: `https://<worker>/api/ranking` が `{"total":0,"offset":0,"list":[],"me":null}` を返す。
   D1 未設定なら 503 `storage_unavailable`、未マイグレーションなら 503 `schema_missing`(ゲーム側は「利用できません」と表示し、架空のデータは出しません)。
7. 推奨: Cloudflare ダッシュボードの Rate Limiting ルールで `/api/register` などにIP単位の上限を追加(コード内の制限と二重化)。

## 仕組み
- 認証: 端末で生成した256bitの秘密値のハッシュだけをサーバーに保存。`Authorization: Bearer <ID>.<秘密値>` で毎回照合。IDだけでは本人になれません。
- 成績: ホストが開始を登録(`/api/match/open`)→ホスト・ゲスト双方がスコアを報告(`/api/match/report`)。報告が一致し、経過時間が妥当な場合のみ、サーバーがEloを計算して1回だけ反映(試合IDは主キー、確定は `status='open'` の1回限り)。
  同じ2人の組み合わせは1日5試合までランキングに反映。
- 順位: ポイント → 勝利数 → 試合数が少ない → 登録が早い → ID順。試合0のプレイヤーは順位なし。
- オンライン表示: `last_seen` が3分以内。クライアントは2分ごとに ping(D1 の書き込みが増えるため、無料枠では利用者数に注意)。
