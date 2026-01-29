# Guide for SWE Agents (Claude Code / OpenHands / Others)

このドキュメントは、Claude Code や OpenHands などの **SWE エージェント** が  
`CommandMate` リポジトリを扱う際のガイドラインです。

人間開発者とエージェントがペアプロすることを前提に、

- 何を前提としているプロジェクトなのか
- どこをどう触るべきか
- どこは壊してはいけないか

をまとめています。

---

## 0. ゴール

SWE エージェントに期待する主な役割:

- 既存アーキテクチャに沿った **機能追加・仕様変更の実装**
- tmux / Claude CLI / WebSocket / SQLite などを跨いだ **実装の整合性チェック**
- テスト・Lint の整備と改善
- ドキュメント整備（`README.md` / `docs/*.md` の更新）

人間開発者は、エージェントに対して **小さめの粒度のタスク** を渡す前提です。

---

## 1. リポジトリ概要

### 1.1 コアコンセプト

- `1 worktree = 1 tmux session = 1 Claude CLI session`
- Stop フック (`CLAUDE_HOOKS_STOP`) で「処理完了」を検知する **イベント駆動設計**
- `CommandMate` 自身は **ローカル開発補助ツール** であり、  
  セキュリティ境界は「個人開発マシン上」を前提とする  
  （ただし LAN 公開のためのアクセス制御も持つ）

### 1.2 主な技術スタック

- Next.js (App Router) / TypeScript
- Node.js (API Routes)
- SQLite (`db.sqlite`)
- tmux + Claude CLI
- WebSocket

詳細なアーキテクチャは `docs/architecture.md`（予定）や `README.md` の「Architecture Overview」を参照してください。

---

## 2. ディレクトリ構成と責務

想定されるディレクトリ構成（実際の実装に応じて調整される可能性あり）:

```text
src/app/        # UI レイヤ（Next.js App Router）
  page.tsx      # 画面A: Worktree一覧
  worktrees/[id]/page.tsx        # 画面B: チャット画面
  worktrees/[id]/logs/page.tsx   # 画面C: ログビューア

src/api/        # API Routes
  worktrees/route.ts                     # GET /api/worktrees
  worktrees/[id]/send/route.ts           # POST /api/worktrees/:id/send
  worktrees/[id]/messages/route.ts       # GET /api/worktrees/:id/messages
  worktrees/[id]/logs/route.ts           # GET /api/worktrees/:id/logs
  hooks/claude-done/route.ts             # POST /api/hooks/claude-done

src/lib/
  tmux.ts          # tmux コマンドラッパー (new-session, send-keys, capture-pane...)
  worktrees.ts     # git worktree のスキャンと Worktree モデル管理
  db.ts            # SQLite クライアント
  ws-server.ts     # WebSocket サーバと room 管理

src/types/
  models.ts        # Worktree / ChatMessage / SessionState 型定義

docs/
  architecture.md  # アーキテクチャ詳細
  swe-agents.md    # 本ドキュメント
```

SWE エージェントがコードを触る際は、以下の責務分離を意識してください：
- src/app/*
→ UI / 画面ロジック（レンダリングまわり）
- src/api/*
→ HTTP API の入り口（バリデーション／ユースケース呼び出し）
- src/lib/*
→ ドメインロジック / インフラ統合（tmux, db, WebSocket など）
- src/types/*
→ 型定義・共通モデル

⸻

## 3. 不変条件 / 守るべき前提

タスクを実行する際に 絶対に壊してはいけない前提 を列挙します。

### 3.1 セッション構成
1. 1 worktree = 1 tmux session プレフィックス規約
- tmux セッション名は常に cw_{worktreeId} を用いる
- worktreeId は URL セーフな ID（例: feature-foo）
1. Claude CLI 起動時の Stop フック設定
- CLAUDE_HOOKS_STOP 環境変数を必ず設定してから claude を起動する
- Hook には少なくとも worktreeId を含める（JSON で POST）

### 3.2 永続化とログ
1. db.sqlite を Worktree / ChatMessage 永続化の単一ソースとする
- Worktree 一覧やチャット履歴の取得は DB 経由とする
- .claude_logs/*.md は詳細ログ（生ログ）の保存・参照専用
1. ログファイル命名ルール
- 基本形: YYYYMMDD-HHmmss-{worktreeId}-{uuid}.md
- Worktree ごとの .claude_logs/ ディレクトリに保存する

### 3.3 セキュリティ
1. 外部アクセス時は認証必須
- MCBD_BIND=0.0.0.0（LAN からのアクセスを許可）にする場合、
- MCBD_AUTH_TOKEN を必須とし、
- すべての Web UI / API で Authorization: Bearer <token> をチェックする

エージェントは、上記の前提を 仕様変更なしに破壊する提案はしないでください。
仕様変更をしたい場合は、必ず人間開発者の指示で docs/architecture.md や本ドキュメントを先に更新します。

⸻

## 4. データモデルの前提

### 4.1 Worktree

```
interface Worktree {
  id: string;              // "main", "feature-foo" など (URL セーフ)
  name: string;            // "main", "feature/foo" など、表示名
  path: string;            // "/path/to/root/feature/foo" (絶対パス)
  lastMessageSummary?: string; // 最後のメッセージ要約（Worktree一覧用）
  updatedAt?: Date;        // 最終メッセージの timestamp
}
```

### 4.2 ChatMessage

```
type ChatRole = "user" | "claude";

interface ChatMessage {
  id: string;           // UUID
  worktreeId: string;   // Worktree.id
  role: ChatRole;
  content: string;      // UI表示用の「全文」テキスト
  summary?: string;     // 任意の短い要約（Worktree一覧などに利用可能）
  timestamp: Date;
  logFileName?: string; // 対応する Markdown ログファイル名（相対パス）
  requestId?: string;   // 将来の拡張用: 1送信=1 UUID
}
```

### 4.3 セッション状態

```
interface WorktreeSessionState {
  worktreeId: string;
  lastCapturedLine: number; // tmux capture-pane の前回取得行数
}
```

- 差分抽出方式（「前回の終端行から新規行を取得」）を前提とします。
- 実装詳細やストレージ形式（DB or メモリ or ファイル）は、今後の実装方針に依存しますが、「差分抽出を行う」というコンセプトは維持してください。

⸻

## 5. 典型的なタスク例

SWE エージェントに任せやすいタスク例です。

### 5.1 UI/UX まわり
- 画面A（Worktree 一覧）に 検索／フィルタ を追加する
- 画面B（チャット）のバブル表示を改善（user / claude で色分け）
- 画面B に 無限スクロール を導入し、古いメッセージを追加ロード
- 画面C（ログビューア）に「User」「Claude」見出しへのジャンプ機能を追加

### 5.2 バックエンド / API まわり
- GET /api/worktrees/:id/messages に before / limit パラメータを追加し、ページング実装
- Stop フック API (POST /api/hooks/claude-done) が requestId を受け取れるように拡張
- tmux capture-pane 差分抽出処理のリファクタリング・ユニットテスト追加
- MCBD_AUTH_TOKEN の検証ロジックを共通ミドルウェアとして切り出す

### 5.3 インフラ・ツールまわり
- ESLint / Prettier / TypeScript 設定の追加・改善
- GitHub Actions（CI）の実装
- npm run lint / npm test を PR ごとに実行
- ローカル検証用のスクリプト追加
- ダミー worktree で最小限の動作確認を行う CLI など

⸻

## 6. 実行・テスト方法（エージェント向けの前提）

SWE エージェントが「実行コマンド」を提示する際は、
以下のコマンド群を標準として扱ってください。

### 6.1 起動

```
npm run dev
```

- Next.js の dev サーバが起動します。
- デフォルトポートは MCBD_PORT（未指定時は 3000）。

### 6.2 Lint

```
npm run lint
```
- TypeScript / ESLint を想定しています。

### 6.3 テスト

```
npm test
```

- 実装進捗に応じて、ユニットテストや簡易統合テストを追加していきます。
- SWE エージェントは「この変更を行ったので、npm test を実行して通ることを確認してください」といった形で指示する前提です。

⸻

## 7. 変更の方針とレビュー観点

SWE エージェントが PR 相当の変更提案を行うとき、
自分自身で以下の観点をチェックすることを推奨します。
- 既存の責務分離を守っているか（UI / API / lib / types を適切に分離しているか）
- ライセンスヘッダや LICENSE ファイルに誤った変更を加えていないか
- MCBD_ROOT_DIR / MCBD_BIND / MCBD_AUTH_TOKEN など、既存設定値の意味を崩していないか
- 新しい環境変数や設定を追加した場合、README.md と docs/configuration.md（存在する場合）を更新したか
- 必要に応じてテストを追加し、少なくとも既存テストが壊れていないか確認したか
- UI 変更がモバイルでも破綻していないか（レスポンシブの確認）

⸻

## 8. Claude Code / OpenHands への初期コンテキスト例

人間開発者が Claude Code 等のエージェントにこのリポジトリを渡す際の
初期プロンプトの例です。

あなたは CommandMate というローカル開発コンパニオンツールの SWE エージェントです。

このツールは、git worktree ごとに tmux + Claude CLI セッションを張り、
スマホブラウザからブランチ単位のチャット UI として操作できるようにするものです。

重要な前提:
- 1 worktree = 1 tmux session (`cw_{worktreeId}`)
- Claude CLI は `CLAUDE_HOOKS_STOP` 環境変数で Stop フックを設定してから起動します
- セッション完了時、Stop フックが `POST /api/hooks/claude-done` を叩き、
  バックエンドは `tmux capture-pane` により差分ログを取得して DB と `.claude_logs/*.md` に保存し、
  WebSocket で UI に ChatMessage をプッシュします

リポジトリ構成やアーキテクチャは `README.md` と `docs/architecture.md` を参照してください。
私が指示するタスクについて、

- どのファイルに手を入れるべきか
- どのような影響範囲があるか
- 必要であればテストや Lint の実行コマンド

を明示しながら、段階的に変更案を提示してください。

このようなコンテキストを付与することで、エージェントは
- CommandMate が「何をするツールか」
- どこがコアコンセプトか
- どの層のコードを触るべきか

を誤解しにくくなります。

⸻

## 9. 仕様変更が必要なときの流れ

もし人間開発者が「アーキテクチャの前提そのものを変えたい」と思った場合（例: Stop フックではなくポーリング方式に変える、tmux を使わない構成を追加する 等）は、
1. 先に docs/architecture.md や 本ドキュメント（swe-agents.md）を更新し、
1. その変更を前提に、SWE エージェントに実装タスクを依頼する

という順番を推奨します。

「仕様 → ドキュメント → 実装」の順番を守ることで、
人間とエージェントの協調作業がスムーズになります。