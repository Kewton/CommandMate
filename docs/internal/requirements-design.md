# CommandMate Requirements & Design

> git worktree ごとに Claude Code / tmux セッションを張り、スマホブラウザからチャット操作できる開発コンパニオンツールの「要求・要件・設計方針」をまとめたドキュメント。

- プロダクト名称: **CommandMate**
- バージョン: v2.1 要求・要件・設計方針
- 対象範囲:
  - スマホ/PC ブラウザから操作する Web UI
  - Next.js / Node.js ベースのバックエンド
  - tmux / Claude CLI との連携
  - SQLite / ローカル FS を用いた永続化

詳細な技術アーキテクチャは `docs/architecture.md` を参照してください。

---

## 0. 用語

- **root ディレクトリ**: `MCBD_ROOT_DIR` で指定される、git worktree をまとめて管理しているローカルディレクトリ。
- **worktree**: git worktree で管理されたブランチ用ディレクトリ（例: `main`, `feature/foo`）。
- **worktreeId**: URL セーフな形式に正規化された worktree の識別子（例: `feature-foo`）。
- **tmux セッション**: `cw_{worktreeId}` という命名規則で起動される tmux セッション。
- **Stop フック**: Claude CLI の `CLAUDE_HOOKS_STOP` 環境変数に設定される、処理完了時に呼び出されるフックコマンド。

---

## 1. ユーザー要求（Requirements）

### 1.1 UX 観点の要求

1. 開発者は **スマホブラウザ** や PC ブラウザから CommandMate を開き、
   - git worktree 単位で Claude CLI セッションにアクセスできること。

2. [画面A: Worktree 一覧] にて、
   - ルートディレクトリ配下の worktree が **トーク一覧風 UI** で表示されること。
   - 各 worktree に対して、少なくとも以下が表示されること:
     - ブランチ名（例: `main`, `feature/foo`）
     - 最後のチャット内容の要約
     - 最終更新日時（例: 相対時間表示）。

3. [画面B: チャット画面] にて、
   - worktree ごとに **独立したチャットルーム**として表示されること。
   - 過去のチャット履歴が閲覧できること。
   - 入力フォームから Claude に自然言語で指示を送信できること。
   - 送信後、UI はすぐに「送信中…」などの状態を表示し、**応答を待ってブロックしない**こと。

4. Claude の処理完了後、
   - Claude からの応答が UI に **リアルタイムに追記**されること。
   - PC とスマホなど複数クライアントから同じ worktree を見ている場合、すべての画面が同期して更新されること。

5. [画面C: ログビューア] にて、
   - worktree ごとの **詳細ログ（Markdown）** を一覧で閲覧できること。
   - 個々のログファイルを開くと、Claude の詳細な出力・コンテキストが確認できること。

6. ユーザーは「開発コード側での詳細なログ確認」と「チャット UI 上の簡易表示」を使い分けられること。

---

## 2. システム要件（System Requirements）

### 2.1 機能要件（Functional Requirements）

#### 2.1.1 UI/UX（スマホ対応）

- [FR-UI-01] スマホブラウザで快適に操作できるレスポンシブデザインであること。
- [FR-UI-02] **画面A (ホーム): Worktree一覧**
  - ルートディレクトリ配下の worktree 一覧を取得して表示すること。
  - 一覧は **最終更新日時の新しい順** にソートされること。
- [FR-UI-03] **画面B (チャット)**
  - worktree を選択すると、その worktree 専用のチャット画面に遷移すること。
  - 過去の ChatMessage を時系列で表示すること。
  - 入力欄からメッセージ（指示）を送信できること。
- [FR-UI-04] **画面C (ログ)**
  - 該当 worktree 配下の `.claude_logs/` の Markdown ファイル一覧を表示すること。
  - ファイルを選択すると Markdown レンダリングビューを表示すること。

#### 2.1.2 セッション管理

- [FR-SESSION-01] **1 worktree = 1 tmux セッション** + **1 Claude CLI セッション**の対応とすること。
- [FR-SESSION-02] セッションは「遅延起動」とし、
  - 該当 worktree が初めて利用されたタイミング（初回アクセスまたは初回送信）で tmux セッションを起動すること。
- [FR-SESSION-03] tmux セッション名は `cw_{worktreeId}` であること。
- [FR-SESSION-04] Claude CLI が落ちている／セッションが存在しない場合、
  - 再度 API から指示が来た際に自動で再起動すること。

#### 2.1.3 Claude 連携（Stop フック）

- [FR-CLAUDE-01] チャット送信後、UI は応答を待たずに「送信済み」状態になること（非同期）。
- [FR-CLAUDE-02] Claude からの処理完了は `CLAUDE_HOOKS_STOP` に設定されたフック経由で通知されること。
- [FR-CLAUDE-03] Stop フックは最低限 `worktreeId` を API に渡すこと。
- [FR-CLAUDE-04] フック API (`/api/hooks/claude-done`) は、
  - 対応する tmux セッションから出力を取得し、
  - 差分を解析した上で ChatMessage として DB に保存し、
  - WebSocket 経由で UI にプッシュすること。

#### 2.1.4 ログ管理

- [FR-LOG-01] 指示と応答を含む詳細ログを、各 worktree の `.claude_logs/` ディレクトリ配下に Markdown として保存すること。
- [FR-LOG-02] ログファイル名は `YYYYMMDD-HHmmss-{worktreeId}-{uuid}.md` の形式とすること。
- [FR-LOG-03] DB 上の ChatMessage レコードから、対応するログファイルを参照できるように `logFileName` を保存すること。
- [FR-LOG-04] Worktree 一覧で表示する「最後のメッセージ要約」は、最新の ChatMessage の `summary` または `content` から更新すること。

### 2.2 非機能要件（Non-functional Requirements）

#### 2.2.1 セキュリティ

- [NFR-SEC-01] デフォルトでは `localhost` (`127.0.0.1`) にバインドし、同一マシンからのみアクセス可能とすること。
- [NFR-SEC-02] `MCBD_BIND=0.0.0.0` などで LAN 公開する場合は、`MCBD_AUTH_TOKEN` によるトークン認証を必須とすること。
- [NFR-SEC-03] root ディレクトリ配下の worktree のみを対象とし、
  - API から任意のパスを直接指定して触れることがないようにすること。

#### 2.2.2 応答性

- [NFR-PERF-01] 画面A → 画面B への遷移（チャット履歴の初回読み込み）は、ローカル環境で 1 秒以内を目標とする。
- [NFR-PERF-02] Claude 完了から UI への WebSocket 通知までのオーバーヘッドは、できる限り小さく（目安 100〜300ms 程度）保つこと。
- [NFR-PERF-03] UI はすべての API 呼び出しを非同期で扱い、操作がブロックされないようにすること。

#### 2.2.3 可用性・耐障害性

- [NFR-AVAIL-01] tmux セッションが落ちた場合に、次回メッセージ送信時に自動再起動する仕組みを持つこと。
- [NFR-AVAIL-02] Claude CLI プロセスが終了している場合に検出し、再度起動できるようにする（少なくとも API 実行時の存在チェック）。
- [NFR-AVAIL-03] Stop フックが届かないケース（タイムアウト／ネットワークエラー）に備え、最低限ログ上に異常が分かる状態を残すこと。

#### 2.2.4 保守性・拡張性

- [NFR-MAINT-01] UI / API / ドメインロジック / インフラ（tmux, DB 等）が責務ごとに分離された構成とすること。
- [NFR-MAINT-02] 将来的な `requestId` 導入やマルチ LLM 対応を阻害しない API デザインを行うこと。
- [NFR-MAINT-03] SWE エージェント（Claude Code など）が理解しやすいよう、`README.md` / `docs/*.md` を整備すること。

---

## 3. 設計方針（Design Policies）

### 3.1 全体設計方針

1. **イベント駆動型アーキテクチャの採用**
   - Claude CLI の Stop フック (`CLAUDE_HOOKS_STOP`) をトリガーとして利用し、
   - ポーリング（定期的な状態監視）を避ける。
   - 完了イベントを起点に tmux 出力の取得・ログ保存・UI 更新を行う。

2. **1 worktree = 1 セッションの単純さ**
   - 1 worktree ごとに 1 tmux セッション＋1 Claude セッションを割り当てる。
   - セッション名規約：`cw_{worktreeId}`。
   - この単純なマッピングにより、デバッグや運用の分かりやすさを優先する。

3. **ローカルファースト・開発者体験優先**
   - ローカル環境での動作・デバッグを前提とし、セットアップを小さく保つ。
   - 外部公開や本番運用よりも、開発者の「日々の作業が楽になること」を優先する。

4. **UI とログビューの二層構造**
   - 日常的にはチャット UI で軽量なコンテキスト表示を行い、
   - 必要に応じて `.claude_logs/` の Markdown で詳細を確認する二層構造とする。
   - これにより「必要な時だけ詳細に潜る」ことが可能となる。

---

### 3.2 Stop フック連携設計

- Claude CLI 起動時には必ず `CLAUDE_HOOKS_STOP` を設定する。
- フックは最低限 `worktreeId` を JSON として POST する。
- 将来的には `requestId` を追加し、「どのリクエストの完了か」をより厳密に紐づけられる設計余地を残す。

```bash
HOOK_COMMAND="curl -X POST http://localhost:3000/api/hooks/claude-done \
  -H 'Content-Type: application/json' \
  -d '{\"worktreeId\":\"{worktreeId}\"}'"
export CLAUDE_HOOKS_STOP="${HOOK_COMMAND}"
```
- Stop フックを一元的な完了通知のインターフェースとし、
それ以外の経路（例: log ファイルの直接監視など）は採用しない。

⸻

### 3.3 tmux セッション管理設計
- セッション作成:
- tmux new-session -d -s "cw_{worktreeId}" -c "{worktreePath}" により起動。
- Claude 起動:
- セッション内で CLAUDE_HOOKS_STOP 設定 → claude 起動の順で send-keys。
- 存在チェック:
- tmux has-session -t cw_{worktreeId} によりセッションの有無を判定。
- 再起動方針:
- API 実行時にセッションが無ければ、新規作成フロー（遅延起動）を実行する。
- より高度な死活監視（ps による claude プロセス確認など）はオプション扱いとし、実装コストと必要性のバランスを見て検討する。

⸻

### 3.4 リアルタイム通知設計（WebSocket）
- WebSocket サーバは worktree 単位の「room / channel」を持ち、
- クライアントは閲覧中の worktreeId を subscribe する。
- 新しい ChatMessage が生成されるたびに、
- 該当 worktreeId を購読中のクライアントへブロードキャストする。
- SSE（Server-Sent Events）などの代替手段は将来のオプションとし、初期版では WebSocket を標準とする。

⸻

### 3.5 永続化設計
1. SQLite (db.sqlite)
    -  Worktree 一覧、ChatMessage、セッション状態（lastCapturedLine）などのメタ情報を保持する。
    - ローカルアプリケーション用途として、
    - JSON ファイルの直接管理より堅牢かつ高速なため、SQLite を採用。
1. Markdown ログ (.claude_logs/)
    - 各 worktree 配下に .claude_logs/ ディレクトリを作成し、その中に Markdown ログを保存。
    - ログにはユーザー指示と Claude 応答の両方を含める。
    - ログファイル名は一意性と時系列性を両立する命名規則とする。
1. クリーンアップポリシー
    - 初期バージョンでは自動削除は行わず、
    - 将来的に n 日より古いログを削除・アーカイブする CLI の追加を検討する。

⸻

### 3.6 セキュリティ設計
- 初期値は MCBD_BIND=127.0.0.1 とし、ローカルホスト限定で動作させる。
- LAN 公開などで MCBD_BIND=0.0.0.0 とする場合、
- MCBD_AUTH_TOKEN を必須とし、すべての Web UI / API / WebSocket でトークン認証を行う。
- HTTPS / TLS については、
- CommandMate 自身は HTTP のままとし、
- 必要に応じて前段のリバースプロキシ（Caddy / nginx / Traefik 等）で終端する想定とする。

⸻

### 3.7 拡張性・将来の余地
1. requestId ベースの厳密な紐づけ
    - POST /api/worktrees/:id/send 時に requestId を払い出し、
    - Stop フックやログファイルにも埋め込み、
    - 「どのリクエストの完了か」をより厳密にトレース可能にする余地を残す。
1. マルチ LLM 対応
    - Claude 以外の CLI（OpenAI, LM Studio, OLLAMA 等）をサポートする場合、
    - セッションごとに provider / model 情報を持つ設計に拡張可能なよう、
    - 現設計では Claude 固定にしつつも抽象層（tmux ラッパなど）を意識しておく。
1. Observability（可観測性）
    - 応答時間（latency）、エラー率などを将来的に可視化できるよう、
    - ChatMessage や Worktree にメタ情報を追加する余地を残す。
    - 外部の Observability ツール（OpenTelemetry, Langfuse など）と連携する場合、
    - 既存フローにトレーシングを埋め込めるようにする。

⸻

## 4. このドキュメントの運用方針
- 新しい機能を追加する場合、
    1. まず本ドキュメントと docs/architecture.md を更新し、
    1. その上で実装タスクを SWE エージェントや自分自身に割り当てる、という順番を推奨する。
- 要求・要件・設計方針が変わったら、
    - README や SWE エージェント向けドキュメント（docs/swe-agents.md）もあわせて更新し、
    - 「なぜその変更が必要か」が分かるように保つ。
