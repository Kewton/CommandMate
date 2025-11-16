# Issue #1 クイックスタートガイド
# 開発着手のための実践ガイド

**作成日**: 2025-11-17
**対象**: 開発者・SWEエージェント
**関連ドキュメント**:
- [implementation-plan.md](./implementation-plan.md) - 全体計画
- [technical-spec.md](./technical-spec.md) - 技術仕様

---

## 目次

1. [即座に始める](#即座に始める)
2. [Phase別実行コマンド](#phase別実行コマンド)
3. [デバッグTips](#デバッグtips)
4. [よくある問題と解決策](#よくある問題と解決策)
5. [チェックリスト](#チェックリスト)

---

## 即座に始める

### 前提条件の確認

```bash
# Node.js バージョン確認
node --version  # v20以上

# tmux 確認
tmux -V

# Claude CLI 確認
claude --version

# git worktree 確認
git worktree list
```

### Phase 1: プロジェクト初期化（5分）

```bash
# 1. Next.jsプロジェクト作成
npx create-next-app@latest . --typescript --tailwind --app --src-dir --no-git

# プロンプトでの選択:
# ✔ Would you like to use TypeScript? … Yes
# ✔ Would you like to use ESLint? … Yes
# ✔ Would you like to use Tailwind CSS? … Yes
# ✔ Would you like to use `src/` directory? … Yes
# ✔ Would you like to use App Router? … Yes
# ✔ Would you like to customize the default import alias (@/*)? … No

# 2. 追加の依存関係インストール
npm install better-sqlite3 ws uuid
npm install -D @types/better-sqlite3 @types/ws @types/uuid

# Markdown関連
npm install react-markdown remark-gfm rehype-highlight

# 日時ライブラリ（任意）
npm install date-fns

# 3. .env.example 作成
cat > .env.example << 'EOF'
# myCodeBranchDesk Configuration

# ルートディレクトリ（git worktreeを管理しているディレクトリ）
MCBD_ROOT_DIR=/path/to/your/monorepo

# ポート番号（デフォルト: 3000）
MCBD_PORT=3000

# バインドアドレス
# - localhost のみ: 127.0.0.1
# - LAN からアクセス: 0.0.0.0（認証必須）
MCBD_BIND=127.0.0.1

# 認証トークン（MCBD_BIND=0.0.0.0 の場合は必須）
MCBD_AUTH_TOKEN=
EOF

# 4. .env.local 作成（gitignoreされる）
cp .env.example .env.local

# 5. .gitignore 更新
cat >> .gitignore << 'EOF'

# myCodeBranchDesk specific
db.sqlite
db.sqlite-journal
.env.local
.claude_logs/
EOF

# 6. 動作確認
npm run dev
```

ブラウザで http://localhost:3000 を開き、Next.jsのデフォルトページが表示されればOK。

---

## Phase別実行コマンド

### Phase 2: データレイヤー（30分）

```bash
# 1. ディレクトリ作成
mkdir -p src/types src/lib scripts

# 2. 型定義作成
cat > src/types/models.ts << 'EOF'
export interface Worktree {
  id: string;
  name: string;
  path: string;
  lastMessageSummary?: string;
  updatedAt?: Date;
}

export type ChatRole = "user" | "claude";

export interface ChatMessage {
  id: string;
  worktreeId: string;
  role: ChatRole;
  content: string;
  summary?: string;
  timestamp: Date;
  logFileName?: string;
  requestId?: string;
}

export interface WorktreeSessionState {
  worktreeId: string;
  lastCapturedLine: number;
}
EOF

# 3. DB初期化スクリプト作成
# 内容は technical-spec.md の db.ts を参照

# 4. DBマイグレーション実行
npx tsx scripts/init-db.ts

# 5. 確認
ls -lh db.sqlite
```

---

### Phase 3: Worktree管理（20分）

```bash
# 1. worktrees.ts 作成
# 内容:
# - scanWorktrees(): git worktree list 実行
# - parseWorktreeOutput(): 出力パース
# - generateWorktreeId(): URLセーフID生成
# - syncWorktreesToDB(): DB同期

# 2. テスト実行
npx tsx scripts/test-worktrees.ts

# 3. スキャン結果確認
npx tsx -e "
import { scanWorktrees } from './src/lib/worktrees';
console.log(await scanWorktrees());
"
```

---

### Phase 4: tmux統合（40分）

```bash
# 1. tmux.ts 作成
# 関数:
# - hasSession(sessionName)
# - createSession(sessionName, path, worktreeId)
# - sendKeys(sessionName, text)
# - capturePane(sessionName, startLine?)
# - killSession(sessionName)

# 2. テストセッション作成
npx tsx -e "
import { createSession } from './src/lib/tmux';
await createSession('cw_test', process.cwd(), 'test');
console.log('Session created');
"

# 3. セッション確認
tmux ls | grep cw_

# 4. セッションに接続して動作確認
tmux attach -t cw_test

# 5. テストセッション削除
tmux kill-session -t cw_test
```

---

### Phase 5: API Routes（1-2時間）

```bash
# 1. ディレクトリ構造作成
mkdir -p src/app/api/worktrees/\[id\]/send
mkdir -p src/app/api/worktrees/\[id\]/messages
mkdir -p src/app/api/worktrees/\[id\]/logs/\[fileName\]
mkdir -p src/app/api/hooks/claude-done

# 2. 各API Route作成
# - GET /api/worktrees/route.ts
# - POST /api/worktrees/[id]/send/route.ts
# - GET /api/worktrees/[id]/messages/route.ts
# - POST /api/hooks/claude-done/route.ts
# - GET /api/worktrees/[id]/logs/route.ts
# - GET /api/worktrees/[id]/logs/[fileName]/route.ts

# 3. APIテスト
npm run dev

# 別ターミナルで
curl http://localhost:3000/api/worktrees

# 4. send APIテスト
curl -X POST http://localhost:3000/api/worktrees/main/send \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello Claude"}'
```

---

### Phase 6: WebSocket（30分）

```bash
# 1. ws-server.ts 作成

# 2. Next.jsのcustom server設定
# server.js を作成し、WebSocketサーバーを統合

# 3. package.json 更新
# "dev": "node server.js"

# 4. WebSocketテスト（ブラウザ開発者コンソール）
const ws = new WebSocket('ws://localhost:3000/ws');
ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'subscribe', worktreeId: 'main' }));
};
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

---

### Phase 7: 認証（20分）

```bash
# 1. auth.ts 作成

# 2. .env.local 更新
MCBD_BIND=0.0.0.0
MCBD_AUTH_TOKEN=test-token-123

# 3. 認証テスト（失敗ケース）
curl http://localhost:3000/api/worktrees
# 期待: 401 Unauthorized

# 4. 認証テスト（成功ケース）
curl http://localhost:3000/api/worktrees \
  -H 'Authorization: Bearer test-token-123'
# 期待: 200 OK
```

---

### Phase 8-10: UI実装（2-3時間）

```bash
# 1. コンポーネントディレクトリ作成
mkdir -p src/components src/hooks

# 2. 画面A: Worktree一覧
# src/app/page.tsx 実装

# 3. 画面B: チャット
# src/app/worktrees/[id]/page.tsx 実装

# 4. 画面C: ログビューア
# src/app/worktrees/[id]/logs/page.tsx 実装

# 5. スタイリング確認
npm run dev
# http://localhost:3000 をスマホからも確認
```

---

### Phase 11: テスト（1-2時間）

```bash
# 1. テストフレームワーク追加
npm install -D vitest @testing-library/react @testing-library/jest-dom

# 2. vitest.config.ts 作成

# 3. テスト作成
mkdir -p tests/unit tests/integration

# 4. テスト実行
npm test

# 5. カバレッジ確認
npm test -- --coverage
```

---

### Phase 12: ドキュメント整備（30分）

```bash
# 1. README.md 更新
# - 実際のインストール手順を検証
# - スクリーンショット追加（任意）

# 2. CHANGELOG.md 作成
cat > CHANGELOG.md << 'EOF'
# Changelog

## [1.0.0] - 2025-11-17

### Added
- Initial release
- Worktree management
- Chat interface
- Log viewer
- WebSocket real-time updates
- Authentication for LAN access
EOF

# 3. docs/architecture.md 更新
# 実装に基づいて詳細を反映
```

---

## デバッグTips

### tmuxセッションのデバッグ

```bash
# 全セッション確認
tmux ls

# セッションに接続
tmux attach -t cw_main

# セッション内のコマンド履歴確認
tmux capture-pane -t cw_main -p -S -

# セッション削除
tmux kill-session -t cw_main
```

### データベースのデバッグ

```bash
# SQLiteコマンドライン起動
sqlite3 db.sqlite

# テーブル確認
.tables

# Worktree一覧
SELECT * FROM worktrees;

# メッセージ確認
SELECT id, worktree_id, role, substr(content, 1, 50), timestamp
FROM chat_messages
ORDER BY timestamp DESC
LIMIT 10;

# 終了
.quit
```

### ログファイルのデバッグ

```bash
# ログディレクトリ確認
ls -la $MCBD_ROOT_DIR/main/.claude_logs/

# 最新ログ確認
ls -t $MCBD_ROOT_DIR/main/.claude_logs/ | head -1 | xargs -I {} cat "$MCBD_ROOT_DIR/main/.claude_logs/{}"
```

### API デバッグ

```bash
# サーバーログ確認（開発モード）
npm run dev | tee dev.log

# APIレスポンス確認（詳細）
curl -v http://localhost:3000/api/worktrees

# JSONフォーマット
curl -s http://localhost:3000/api/worktrees | jq .
```

### WebSocketデバッグ

ブラウザ開発者コンソールで:

```javascript
// 接続
const ws = new WebSocket('ws://localhost:3000/ws');

// イベントリスナー
ws.onopen = () => console.log('Connected');
ws.onmessage = (e) => console.log('Message:', JSON.parse(e.data));
ws.onerror = (e) => console.error('Error:', e);
ws.onclose = () => console.log('Disconnected');

// サブスクライブ
ws.send(JSON.stringify({ type: 'subscribe', worktreeId: 'main' }));
```

---

## よくある問題と解決策

### 問題1: tmuxセッションが起動しない

**症状**: `createSession` でエラー

**原因**:
- tmuxがインストールされていない
- パス指定が誤り

**解決策**:
```bash
# tmuxインストール確認
which tmux

# macOS
brew install tmux

# Linux
sudo apt-get install tmux
```

---

### 問題2: Claude CLIが応答しない

**症状**: Stopフックが発火しない

**原因**:
- CLAUDE_HOOKS_STOP が設定されていない
- Claude CLIが古いバージョン

**解決策**:
```bash
# 手動でテスト
export CLAUDE_HOOKS_STOP='echo "Hook fired"'
claude

# Claude CLI更新
npm update -g claude-cli  # または適切な更新方法
```

---

### 問題3: WebSocketが接続できない

**症状**: `WebSocket connection failed`

**原因**:
- カスタムサーバーが起動していない
- ポートが競合

**解決策**:
```bash
# ポート確認
lsof -i :3000

# 別のポート使用
MCBD_PORT=3001 npm run dev
```

---

### 問題4: 認証エラーが出る

**症状**: `401 Unauthorized`

**原因**:
- AUTH_TOKENが設定されていない
- Authorizationヘッダーが誤り

**解決策**:
```bash
# .env.local確認
cat .env.local | grep AUTH_TOKEN

# ヘッダー形式確認
# 正: Authorization: Bearer <token>
# 誤: Authorization: <token>
```

---

### 問題5: ログファイルが保存されない

**症状**: `.claude_logs/` が空

**原因**:
- ディレクトリが存在しない
- パーミッションエラー

**解決策**:
```bash
# ディレクトリ作成
mkdir -p $MCBD_ROOT_DIR/main/.claude_logs

# パーミッション確認
ls -ld $MCBD_ROOT_DIR/main/.claude_logs
```

---

## チェックリスト

### Phase 1完了チェック

- [ ] `npm run dev` が正常に起動する
- [ ] http://localhost:3000 にアクセスできる
- [ ] TypeScript エラーがない
- [ ] ESLint エラーがない
- [ ] .env.local が作成されている

### Phase 2完了チェック

- [ ] `db.sqlite` ファイルが作成されている
- [ ] テーブルが正しく作成されている（sqlite3で確認）
- [ ] TypeScript型定義が完成している
- [ ] CRUD関数が動作する

### Phase 3完了チェック

- [ ] `git worktree list` の出力がパースできる
- [ ] worktreeIDが正しく生成される
- [ ] DBにworktreeが保存される
- [ ] スキャン関数が動作する

### Phase 4完了チェック

- [ ] tmuxセッションが作成できる
- [ ] セッション存在チェックが動作する
- [ ] send-keys でコマンド送信できる
- [ ] capture-pane で出力取得できる
- [ ] Stopフック設定が正しく動作する

### Phase 5完了チェック

- [ ] GET /api/worktrees が動作する
- [ ] POST /api/worktrees/:id/send が動作する
- [ ] GET /api/worktrees/:id/messages が動作する
- [ ] POST /api/hooks/claude-done が動作する
- [ ] GET /api/worktrees/:id/logs が動作する
- [ ] エラーハンドリングが適切

### Phase 6完了チェック

- [ ] WebSocketサーバーが起動する
- [ ] クライアントが接続できる
- [ ] subscribeメッセージが処理される
- [ ] broadcastが正しく配信される
- [ ] 再接続が動作する

### Phase 7完了チェック

- [ ] localhost時は認証不要
- [ ] 0.0.0.0時は認証必須
- [ ] 正しいトークンで認証成功
- [ ] 誤ったトークンで認証失敗
- [ ] パストラバーサル対策が動作

### Phase 8-10完了チェック

- [ ] 画面A: Worktree一覧が表示される
- [ ] 画面B: チャット画面が表示される
- [ ] 画面C: ログビューアが表示される
- [ ] レスポンシブデザインが動作（スマホ確認）
- [ ] WebSocketでリアルタイム更新される
- [ ] 無限スクロールが動作する

### Phase 11完了チェック

- [ ] ユニットテストが通る
- [ ] 統合テストが通る
- [ ] カバレッジが50%以上
- [ ] 主要機能の手動テスト完了
- [ ] バグ修正完了

### Phase 12完了チェック

- [ ] README.mdが最新
- [ ] docs/architecture.mdが完成
- [ ] .env.exampleが完備
- [ ] CHANGELOG.mdが作成されている
- [ ] ドキュメントに誤りがない

---

## 開発の進め方

### 1日目（6-8時間）

- Phase 1: プロジェクト基盤構築
- Phase 2: データレイヤー実装
- Phase 3: Worktree管理機能
- Phase 4: tmux統合

**ゴール**: バックエンドの基礎が完成

---

### 2日目（6-8時間）

- Phase 5: API Routes実装（前半）
- Phase 6: WebSocket実装
- Phase 7: 認証・セキュリティ

**ゴール**: API層が完成、動作確認可能

---

### 3日目（6-8時間）

- Phase 5: API Routes実装（後半）
- Phase 8: UI実装 - 画面A
- Phase 9: UI実装 - 画面B（前半）

**ゴール**: 基本的なUIが表示される

---

### 4日目（6-8時間）

- Phase 9: UI実装 - 画面B（後半）
- Phase 10: UI実装 - 画面C
- 統合テスト

**ゴール**: E2Eで動作する

---

### 5日目（6-8時間）

- Phase 11: テスト・品質保証
- バグ修正
- パフォーマンス改善

**ゴール**: 品質基準クリア

---

### 6日目（2-4時間）

- Phase 12: ドキュメント整備
- 最終確認
- リリース準備

**ゴール**: リリース可能状態

---

## 便利なスクリプト

### package.json に追加

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "test": "vitest",
    "test:watch": "vitest --watch",
    "db:init": "tsx scripts/init-db.ts",
    "db:reset": "rm -f db.sqlite && npm run db:init",
    "tmux:clean": "tmux kill-session -a -t cw_",
    "logs:clean": "find $MCBD_ROOT_DIR -name '.claude_logs' -type d -exec rm -rf {} +"
  }
}
```

---

## 次のステップ

1. **Phase 1を開始**: プロジェクト初期化
2. **動作確認**: 各Phaseごとに必ず動作確認
3. **進捗記録**: dev-reports/feature/1/ に進捗を記録
4. **質問**: 不明点があれば issue や discussion で確認

---

**作成者**: Claude (SWE Agent)
**最終更新**: 2025-11-17
