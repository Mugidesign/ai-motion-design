# AI Motion Design Factory

AIエージェントが商品URL/画像から広告動画を自動生成し、ポートフォリオ公開・見込み客探索・営業文下書き・受注管理・請求・分析までを担う、マルチテナントSaaSプラットフォームです。13の独立したAIエージェントがCloudflare Workers上のDurable Objectsとして動作し、MCP（Model Context Protocol）でツール群を抽象化しています。

**この構成は、Cloudflareの無料枠 + オープンソースソフトウェアのみで動きます。** Anthropic/OpenAIも商用動画生成APIも一切必須ではありません（既定はすべて無料/OSS、必要に応じてオプトインで商用サービスに切り替え可能）。詳細は [`docs/06-oss-free-stack.md`](./docs/06-oss-free-stack.md) を参照してください。

## 設計ドキュメント

実装より先に、まず設計の全体像を読むことをお勧めします。

| # | ドキュメント | 内容 |
|---|---|---|
| 1 | [`docs/01-overview-architecture.md`](./docs/01-overview-architecture.md) | 全体アーキテクチャ・技術スタック・ディレクトリ構成 |
| 2 | [`docs/02-database-api-mcp.md`](./docs/02-database-api-mcp.md) | データベース設計・API設計・MCP設計 |
| 3 | [`docs/03-agents-workflow.md`](./docs/03-agents-workflow.md) | 13エージェントの設計・パイプライン設計 |
| 4 | [`docs/04-uiux-roadmap-mvp.md`](./docs/04-uiux-roadmap-mvp.md) | UI/UX設計・実装ロードマップ・MVP範囲 |
| 5 | [`docs/05-ops-security-compliance-cost.md`](./docs/05-ops-security-compliance-cost.md) | 本番運用・セキュリティ・**コンプライアンス設計**・コスト最適化 |
| 6 | [`docs/06-oss-free-stack.md`](./docs/06-oss-free-stack.md) | **OSS・無料構成ガイド**（1〜5の有料依存をすべて置き換えた差分） |

ドキュメント1・2・3・5には、6での変更点を示す更新通知が先頭にあります。実装の正とすべきは常にコード自体（`packages/db/src/schema.ts`等）です。

## クイックスタート

```bash
# 1. 依存関係インストール
pnpm install

# 2. 自前インフラ（Postgres + pgvector + 認証）を起動
cp .env.example .env
# .env を編集: POSTGRES_PASSWORD, GOTRUE_AUTH_ADMIN_PASSWORD を設定
node scripts/generate-supabase-keys.mjs "$(openssl rand -base64 48)"
# 出力を .env の該当行に反映
pnpm infra:up

# 3. フロントエンド用の環境変数
cp apps/web/.env.local.example apps/web/.env.local
# NEXT_PUBLIC_SUPABASE_ANON_KEY を .env と同じ値に設定

# 4. 各Workerをローカル起動（別ターミナルで並行実行）
pnpm dev:gateway       # :8787
pnpm dev:agents        # :8788
pnpm dev:orchestrator
pnpm dev:mcp:motion    # :8789
pnpm dev:mcp:leads     # :8790
pnpm dev:mcp:comms     # :8791
pnpm dev:mcp:knowledge # :8792
pnpm dev:mcp:crm       # :8793

# 5. フロントエンド起動
pnpm dev:web           # :3000
```

初回起動だけならMotion Generatorは`mock`プロバイダ（プレースホルダー動画、$0）で一通り動作確認できます。実際の動画を生成するには`infra/oss-video-server/README.md`（無料GPU枠でのWan2.1セットアップ）または商用APIキーのいずれかが必要です。

## リポジトリ構成

```
apps/web/              Next.js フロントエンド（放送コントロールルーム風UI）
packages/
  db/                   Drizzleスキーマ + マイグレーション（唯一のスキーマ正）
  shared-types/         MCP/Agent I/OのZodスキーマ（型とランタイム検証を共有）
  agent-kit/            13エージェント共通の基底クラス（LLM呼び出し・MCP呼び出し・実行ログ）
workers/
  api-gateway/          認証・レート制限・REST API（Hono）
  agents/               13エージェント（Durable Objects）
  orchestrator/         パイプライン状態マシン + Cron Trigger
  mcp-servers/          5つのMCPサーバー（動画生成/リード/通信/ナレッジ/CRM・請求）
infra/
  docker-compose.yml    Postgres+pgvector, GoTrue認証, nginx, (任意)Ollama/pgweb
  supabase/              RLSポリシー・ロール設定・カスタムクレームhook・初期スキーマ投入用SQL
  oss-video-server/      Wan2.1推論サーバー（無料GPU枠向け）
docs/                   設計ドキュメント1〜6（上表）
scripts/                鍵生成・一括デプロイスクリプト
```

## 技術スタック

- **実行基盤**：Cloudflare Workers, Durable Objects（`agents`パッケージ）
- **DB**：Postgres + pgvector（自前ホスト、`docker-compose.yml`）、Drizzle ORM
- **認証**：Supabase Auth (GoTrue)、自前ホスト
- **LLM**：既定はCloudflare Workers AI（オープンウェイト、無料枠）。Ollama/Anthropic/OpenAIへ環境変数だけで切替可能
- **動画生成**：`mock`（プレースホルダー）/ `oss-selfhosted`（Wan2.1、無料GPU枠）/ 商用API（Runway, Kling等）
- **フロントエンド**：Next.js 15, React, TypeScript, Tailwind
- **決済**：Stripe（請求書発行のみ、コア機能とは疎結合）

## 既知の未実装・要検証箇所

正直な現状として、以下はこのスキャフォールドの時点で未実装、または実装前に検証が必要です。

- Notion/GitHub/Google DriveのRAG取り込み（OAuth接続が必要、`knowledge-mcp`にTODOあり）
- luma/pika/veo/higgsfield/openai動画プロバイダのアダプタ本体（`runway.ts`/`kling.ts`と同じ形で追加可能な設計にしてある）
- Runway/Klingアダプタのエンドポイント・レスポンス形式は実アカウントでの検証が未実施（コード内にコメントで明記）
- GoTrueのCustom Access Token Hook設定（`GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_*`環境変数名）は、Supabaseの仕様変更の影響を受けやすい箇所として明示的にフラグ済み
- 動画生成のポーリングは現状Motion Designer Agent内の同期ループ（`mock`/draft向け）。本番の長時間レンダリングには`job_queue`ベースの非同期化が必要（コード内に設計メモあり）

各ファイルの冒頭コメントに、想定される検証ポイントと理由を記載してあります。「動くはず」で終わらせず、実アカウント・実環境での検証を経てから商用投入してください。
