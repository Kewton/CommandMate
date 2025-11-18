# Issue #2: 機能強化 - 実装計画書

## 概要

本ドキュメントは Issue #2 の実装を段階的に進めるための詳細な作業計画です。

## 実装スケジュール

### 全体スケジュール（目安）

| フェーズ | 期間 | 内容 |
|---------|------|------|
| Phase 1-1 | 2-3時間 | DB拡張・マイグレーション |
| Phase 1-2 | 2-3時間 | 複数リポジトリ対応 |
| Phase 1-3 | 2-3時間 | メモ機能実装 |
| Phase 1-4 | 2-3時間 | 最新メッセージ表示 |
| Phase 1-5 | 2-3時間 | テスト・バグフィクス |
| **合計** | **10-15時間** | **Phase 1完了** |

## Phase 1-1: データモデル・DB拡張とマイグレーション

### 目標
データベーススキーマを拡張し、マイグレーション機能を実装する

### タスク一覧

#### Task 1.1: マイグレーション基盤の実装
**目的**: スキーマバージョン管理システムの構築

**成果物**:
- `src/lib/db-migrations.ts`（新規）

**作業内容**:
```typescript
// 1. Migration インターフェース定義
export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
  down?: (db: Database.Database) => void;
}

// 2. スキーマバージョンテーブル作成
// 3. runMigrations() 関数実装
// 4. getCurrentVersion() 関数実装
```

**チェックリスト**:
- [ ] Migration インターフェース定義
- [ ] schema_version テーブル作成
- [ ] runMigrations() 関数実装
- [ ] マイグレーション配列の基盤作成
- [ ] 単体テスト作成

**想定時間**: 1時間

---

#### Task 1.2: Migration v2 の実装
**目的**: 複数リポジトリ・メモ対応のスキーマ変更

**成果物**:
- `src/lib/db-migrations.ts`（Migration v2追加）

**作業内容**:
```sql
-- 1. worktrees テーブルにカラム追加
ALTER TABLE worktrees ADD COLUMN repository_path TEXT;
ALTER TABLE worktrees ADD COLUMN repository_name TEXT;
ALTER TABLE worktrees ADD COLUMN memo TEXT;
ALTER TABLE worktrees ADD COLUMN last_user_message TEXT;
ALTER TABLE worktrees ADD COLUMN last_user_message_at INTEGER;

-- 2. インデックス追加
CREATE INDEX idx_worktrees_repository ON worktrees(repository_path);
```

**チェックリスト**:
- [ ] ALTER TABLE 文の実装
- [ ] インデックス作成
- [ ] 既存データ移行ロジック実装
- [ ] findGitRepositoryRoot() 関数実装
- [ ] マイグレーション動作確認

**想定時間**: 1.5時間

---

#### Task 1.3: データモデルの拡張
**目的**: TypeScript型定義の更新

**成果物**:
- `src/types/models.ts`（Worktree拡張）

**作業内容**:
```typescript
// 1. Worktree インターフェース拡張
export interface Worktree {
  id: string;
  name: string;
  path: string;
  repositoryPath: string;      // 追加
  repositoryName: string;       // 追加
  memo?: string;                // 追加
  lastUserMessage?: string;     // 追加
  lastUserMessageAt?: Date;     // 追加
  lastMessageSummary?: string;  // 既存（非推奨マーク）
  updatedAt?: Date;
}

// 2. WorktreesByRepository インターフェース追加
export interface WorktreesByRepository {
  repositoryPath: string;
  repositoryName: string;
  worktrees: Worktree[];
}
```

**チェックリスト**:
- [ ] Worktree インターフェース更新
- [ ] WorktreesByRepository 追加
- [ ] JSDoc コメント追加
- [ ] 既存コードのコンパイルエラー確認

**想定時間**: 30分

---

#### Task 1.4: DB関数の拡張
**目的**: 新しいデータ構造に対応したCRUD関数の実装

**成果物**:
- `src/lib/db.ts`（関数追加・更新）

**作業内容**:
```typescript
// 1. updateWorktreeMemo() 実装
// 2. updateLatestUserMessage() 実装
// 3. getWorktreesByRepository() 実装
// 4. getWorktrees() の返り値を新しい型に対応
```

**チェックリスト**:
- [ ] updateWorktreeMemo() 実装
- [ ] updateLatestUserMessage() 実装
- [ ] getWorktreesByRepository() 実装
- [ ] truncate() ユーティリティ関数実装
- [ ] 既存のgetWorktrees()を新しい型に対応
- [ ] 単体テスト作成

**想定時間**: 1時間

---

### Phase 1-1 完了基準
- [x] すべてのタスクのチェックリストが完了
- [x] マイグレーションが正常に動作
- [x] 既存データが正しく移行される
- [x] TypeScriptのコンパイルエラーなし
- [x] テストがすべてパス

---

## Phase 1-2: 複数リポジトリ対応

### 目標
環境変数から複数のリポジトリパスを読み込み、すべてのworktreeを管理できるようにする

### タスク一覧

#### Task 2.1: 環境変数の読み込み
**目的**: 複数リポジトリパスの取得と検証

**成果物**:
- `src/lib/config.ts`（新規）または既存ファイルに追加

**作業内容**:
```typescript
// 1. getRepositoryPaths() 実装
export function getRepositoryPaths(): string[] {
  const reposEnv = process.env.WORKTREE_REPOS;

  if (!reposEnv) {
    // 後方互換性: WORKTREE_BASE_PATH を使用
    const basePath = process.env.WORKTREE_BASE_PATH || process.cwd();
    return [basePath];
  }

  return reposEnv.split(',').map(p => p.trim()).filter(Boolean);
}

// 2. validateRepositoryPaths() 実装
export function validateRepositoryPaths(paths: string[]): string[] {
  return paths.filter(p => {
    if (!fs.existsSync(p)) {
      console.warn(`Repository path does not exist: ${p}`);
      return false;
    }
    if (!fs.existsSync(path.join(p, '.git'))) {
      console.warn(`Path is not a git repository: ${p}`);
      return false;
    }
    return true;
  });
}
```

**チェックリスト**:
- [ ] getRepositoryPaths() 実装
- [ ] validateRepositoryPaths() 実装
- [ ] .env.example に WORKTREE_REPOS の例を追加
- [ ] 単体テスト作成
- [ ] エラーハンドリング確認

**想定時間**: 45分

---

#### Task 2.2: worktreeスキャナーの拡張
**目的**: 複数リポジトリのworktreeを並列スキャン

**成果物**:
- `src/lib/worktree-scanner.ts`（既存ファイル修正）

**作業内容**:
```typescript
// 1. scanWorktrees() を単一リポジトリ用に変更
export async function scanSingleRepository(
  repoPath: string,
  db: Database.Database
): Promise<Worktree[]> {
  // 既存のロジック + repository_path, repository_name を設定
}

// 2. scanAllRepositories() を追加（並列処理）
export async function scanAllRepositories(
  db: Database.Database
): Promise<Worktree[]> {
  const repoPaths = validateRepositoryPaths(getRepositoryPaths());

  const results = await Promise.all(
    repoPaths.map(repoPath => scanSingleRepository(repoPath, db))
  );

  return results.flat();
}
```

**チェックリスト**:
- [ ] scanSingleRepository() リファクタリング
- [ ] repository_path, repository_name の設定ロジック
- [ ] scanAllRepositories() 実装
- [ ] エラーハンドリング（リポジトリが見つからない場合など）
- [ ] パフォーマンステスト（複数リポジトリ）

**想定時間**: 1.5時間

---

#### Task 2.3: サーバー起動時の処理更新
**目的**: サーバー起動時に複数リポジトリをスキャン

**成果物**:
- `server.ts`（既存ファイル修正）

**作業内容**:
```typescript
// 1. 初期化処理の更新
async function initializeServer() {
  const db = getDatabase();

  // マイグレーション実行
  runMigrations(db);

  // 複数リポジトリスキャン
  console.log('Scanning worktrees...');
  const repoPaths = getRepositoryPaths();
  console.log(`Repositories: ${repoPaths.join(', ')}`);

  const worktrees = await scanAllRepositories(db);
  console.log(`✓ Found and synced ${worktrees.length} worktrees`);
}
```

**チェックリスト**:
- [ ] runMigrations() 呼び出し追加
- [ ] scanAllRepositories() 呼び出し
- [ ] ログ出力の改善
- [ ] エラーハンドリング
- [ ] 動作確認（複数リポジトリ）

**想定時間**: 30分

---

#### Task 2.4: APIの拡張（グループ化対応）
**目的**: リポジトリごとにグループ化されたデータを返すAPI

**成果物**:
- `src/app/api/worktrees/route.ts`（既存ファイル修正）

**作業内容**:
```typescript
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const grouped = searchParams.get('grouped') === 'true';

  const db = getDatabase();

  if (grouped) {
    const repositories = getWorktreesByRepository(db);
    return NextResponse.json({ repositories });
  } else {
    const worktrees = getWorktrees(db);
    return NextResponse.json({ worktrees });
  }
}
```

**チェックリスト**:
- [ ] grouped パラメータ対応
- [ ] getWorktreesByRepository() 呼び出し
- [ ] レスポンス型の定義
- [ ] APIテスト
- [ ] ドキュメント更新

**想定時間**: 45分

---

### Phase 1-2 完了基準
- [x] 環境変数から複数リポジトリを読み込める
- [x] すべてのリポジトリのworktreeがスキャンされる
- [x] DBに正しく repository_path, repository_name が保存される
- [x] GET /api/worktrees?grouped=true が正しく動作
- [x] 既存の単一リポジトリ環境でも動作（後方互換性）

---

## Phase 1-3: メモ機能実装

### 目標
各worktreeにメモを追加・編集・表示できるようにする

### タスク一覧

#### Task 3.1: PATCH APIの実装
**目的**: メモ更新エンドポイントの作成

**成果物**:
- `src/app/api/worktrees/[id]/route.ts`（新規または既存ファイル拡張）

**作業内容**:
```typescript
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const body = await request.json();
  const { memo } = body;

  // バリデーション
  if (memo !== undefined && typeof memo !== 'string') {
    return NextResponse.json({ error: 'Invalid memo' }, { status: 400 });
  }

  const db = getDatabase();
  updateWorktreeMemo(db, params.id, memo || null);

  const worktree = getWorktreeById(db, params.id);
  return NextResponse.json({ worktree });
}
```

**チェックリスト**:
- [ ] PATCH ハンドラ実装
- [ ] バリデーション実装
- [ ] エラーハンドリング
- [ ] レスポンス型定義
- [ ] APIテスト
- [ ] セキュリティチェック（XSS対策）

**想定時間**: 1時間

---

#### Task 3.2: MemoEditorコンポーネント実装
**目的**: メモ編集UIの作成

**成果物**:
- `src/components/worktree/MemoEditor.tsx`（新規）

**作業内容**:
```typescript
// 1. 閲覧モード/編集モードの切り替え
// 2. textareaでのメモ入力
// 3. Save/Cancelボタン
// 4. 保存時のAPI呼び出し
// 5. エラー表示
// 6. ローディング状態
```

**チェックリスト**:
- [ ] コンポーネント基本構造
- [ ] 閲覧モード表示
- [ ] 編集モード表示
- [ ] Save/Cancel処理
- [ ] API呼び出しとエラーハンドリング
- [ ] ローディング状態表示
- [ ] スタイリング
- [ ] レスポンシブ対応

**想定時間**: 1.5時間

---

#### Task 3.3: WorktreeDetailへの統合
**目的**: 詳細画面にメモセクション追加

**成果物**:
- `src/components/worktree/WorktreeDetail.tsx`（既存ファイル修正）

**作業内容**:
```typescript
// サイドバーに Memo セクション追加
<Card padding="lg">
  <CardHeader>
    <CardTitle>Memo</CardTitle>
  </CardHeader>
  <CardContent>
    <MemoEditor
      worktreeId={worktreeId}
      initialMemo={worktree?.memo}
      onSave={(newMemo) => {
        setWorktree(prev => prev ? { ...prev, memo: newMemo } : null);
      }}
    />
  </CardContent>
</Card>
```

**チェックリスト**:
- [ ] MemoEditor import
- [ ] Cardセクション追加
- [ ] onSave ハンドラ実装
- [ ] ステート更新ロジック
- [ ] レイアウト調整
- [ ] 動作確認

**想定時間**: 30分

---

#### Task 3.4: WorktreeCardでのメモ表示
**目的**: 一覧画面でメモのプレビュー表示

**成果物**:
- `src/components/worktree/WorktreeCard.tsx`（既存ファイル修正）

**作業内容**:
```typescript
// メモがある場合のみ表示
{worktree.memo && (
  <div className="mb-3 p-2 bg-amber-50 border-l-2 border-amber-400">
    <div className="flex items-start gap-2">
      <span className="text-amber-600">📝</span>
      <p className="text-sm text-gray-700 line-clamp-2">
        {worktree.memo}
      </p>
    </div>
  </div>
)}
```

**チェックリスト**:
- [ ] メモプレビューセクション追加
- [ ] line-clamp で省略表示
- [ ] アイコン・スタイリング
- [ ] レスポンシブ対応
- [ ] 動作確認

**想定時間**: 30分

---

### Phase 1-3 完了基準
- [x] メモの追加・編集・削除が正常に動作
- [x] 詳細画面でメモ全文が表示される
- [x] 一覧画面でメモプレビューが表示される
- [x] エラーハンドリングが適切
- [x] レスポンシブデザイン対応

---

## Phase 1-4: 最新ユーザーメッセージ表示

### 目標
一覧画面に各worktreeの最新ユーザーメッセージを表示する

### タスク一覧

#### Task 4.1: メッセージ追加時の更新処理
**目的**: 新しいメッセージが追加されたときに最新メッセージをキャッシュ

**成果物**:
- `src/app/api/worktrees/[id]/messages/route.ts`（既存ファイル修正）

**作業内容**:
```typescript
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  // ... 既存のメッセージ保存ロジック

  // メッセージ保存後に最新ユーザーメッセージを更新
  if (role === 'user') {
    updateLatestUserMessage(db, params.id);
  }

  // ... WebSocket broadcast
}
```

**チェックリスト**:
- [ ] POST ハンドラにupdateLatestUserMessage()追加
- [ ] userメッセージの場合のみ更新
- [ ] トランザクション安全性確認
- [ ] 動作テスト

**想定時間**: 30分

---

#### Task 4.2: 相対時間表示のユーティリティ
**目的**: "2時間前" などの相対時間表示

**成果物**:
- date-fns の formatDistanceToNow を使用（既存ライブラリ）

**作業内容**:
```typescript
import { formatDistanceToNow } from 'date-fns';
import { ja } from 'date-fns/locale';

// 使用例
formatDistanceToNow(worktree.lastUserMessageAt, {
  addSuffix: true,
  locale: ja
})
```

**チェックリスト**:
- [ ] date-fns のインストール確認
- [ ] ja locale のインポート
- [ ] 動作確認

**想定時間**: 15分

---

#### Task 4.3: WorktreeCardでの最新メッセージ表示
**目的**: カードに最新ユーザーメッセージセクション追加

**成果物**:
- `src/components/worktree/WorktreeCard.tsx`（既存ファイル修正）

**作業内容**:
```typescript
{worktree.lastUserMessage && (
  <div className="mb-3 p-2 bg-blue-50 border-l-2 border-blue-400">
    <div className="flex items-start gap-2">
      <span className="text-blue-600">👤</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-700 line-clamp-2">
          {worktree.lastUserMessage}
        </p>
        {worktree.lastUserMessageAt && (
          <p className="text-xs text-gray-500 mt-1">
            🕐 {formatDistanceToNow(worktree.lastUserMessageAt, {
              addSuffix: true,
              locale: ja
            })}
          </p>
        )}
      </div>
    </div>
  </div>
)}
```

**チェックリスト**:
- [ ] 最新メッセージセクション追加
- [ ] 相対時間表示
- [ ] line-clamp で省略
- [ ] スタイリング
- [ ] レスポンシブ対応
- [ ] 動作確認

**想定時間**: 45分

---

#### Task 4.4: WebSocketでのリアルタイム更新
**目的**: メッセージ追加時に一覧画面も自動更新

**成果物**:
- `src/components/worktree/WorktreeList.tsx`（既存ファイル修正）
- `server.ts`（WebSocket broadcast拡張）

**作業内容**:
```typescript
// server.ts
function broadcastWorktreeUpdate(worktreeId: string) {
  wss.clients.forEach(client => {
    client.send(JSON.stringify({
      type: 'worktree_update',
      worktreeId
    }));
  });
}

// WorktreeList.tsx
useWebSocket({
  onMessage: (msg) => {
    if (msg.type === 'worktree_update') {
      fetchWorktrees(); // 再取得
    }
  }
});
```

**チェックリスト**:
- [ ] broadcastWorktreeUpdate() 実装
- [ ] メッセージ追加時のbroadcast
- [ ] フロントエンドでの受信処理
- [ ] 一覧の再取得
- [ ] 動作確認

**想定時間**: 1時間

---

### Phase 1-4 完了基準
- [x] 最新ユーザーメッセージが一覧に表示される
- [x] 相対時間が正しく表示される
- [x] メッセージ追加時にリアルタイムで更新される
- [x] メッセージがない場合の表示が適切

---

## Phase 1-5: テスト・バグフィクス・ドキュメント

### 目標
品質保証とドキュメント整備

### タスク一覧

#### Task 5.1: 単体テスト
**目的**: 主要な関数のテスト

**テスト対象**:
- `getRepositoryPaths()`
- `validateRepositoryPaths()`
- `updateWorktreeMemo()`
- `updateLatestUserMessage()`
- `getWorktreesByRepository()`
- `runMigrations()`

**チェックリスト**:
- [ ] DB関数のテスト
- [ ] マイグレーションのテスト
- [ ] 環境変数読み込みのテスト
- [ ] エッジケースのテスト
- [ ] すべてのテストがパス

**想定時間**: 2時間

---

#### Task 5.2: 統合テスト
**目的**: E2Eフローのテスト

**テストシナリオ**:
1. 複数リポジトリの起動・スキャン
2. メモの追加・編集・削除
3. メッセージ送信と最新メッセージ更新
4. WebSocketのリアルタイム更新

**チェックリスト**:
- [ ] マルチリポジトリシナリオ
- [ ] メモ編集フロー
- [ ] メッセージ送信フロー
- [ ] リアルタイム更新確認
- [ ] すべてのテストがパス

**想定時間**: 1時間

---

#### Task 5.3: 手動テスト
**目的**: 実際の環境での動作確認

**テスト項目**:
- [ ] 単一リポジトリ環境での動作（後方互換性）
- [ ] 複数リポジトリ環境での動作
- [ ] メモの追加・編集・削除
- [ ] 長いメモの表示（省略確認）
- [ ] 最新メッセージの表示
- [ ] 相対時間の表示
- [ ] レスポンシブデザイン
- [ ] パフォーマンス（大量のworktree）

**想定時間**: 1時間

---

#### Task 5.4: バグフィクス
**目的**: 発見されたバグの修正

**チェックリスト**:
- [ ] テストで発見されたバグを修正
- [ ] エッジケースの対応
- [ ] パフォーマンス改善
- [ ] UI/UXの微調整

**想定時間**: 1-2時間（バグの数による）

---

#### Task 5.5: ドキュメント更新
**目的**: README とドキュメントの更新

**更新内容**:
- README.md に WORKTREE_REPOS の説明追加
- .env.example の更新
- API ドキュメントの更新
- マイグレーションガイドの作成

**チェックリスト**:
- [ ] README.md 更新
- [ ] .env.example 更新
- [ ] CHANGELOG.md 更新
- [ ] マイグレーションガイド作成

**想定時間**: 1時間

---

### Phase 1-5 完了基準
- [x] すべてのテストがパス
- [x] バグが修正されている
- [x] ドキュメントが最新
- [x] コードレビュー完了

---

## Phase 1 完了チェックリスト

### 機能
- [ ] 環境変数で複数リポジトリを指定できる
- [ ] すべてのリポジトリのworktreeが表示される
- [ ] リポジトリごとにグループ化される
- [ ] 各worktreeにメモを追加・編集できる
- [ ] メモが一覧と詳細画面に表示される
- [ ] 最新のユーザーメッセージが一覧に表示される
- [ ] 相対時間が表示される

### 品質
- [ ] すべてのテストがパス
- [ ] 既存機能に影響なし（リグレッション確認）
- [ ] パフォーマンス問題なし
- [ ] セキュリティチェック完了

### ドキュメント
- [ ] README 更新
- [ ] API ドキュメント更新
- [ ] マイグレーションガイド作成
- [ ] CHANGELOG 更新

### デプロイ
- [ ] ローカル環境で動作確認
- [ ] 本番環境へのデプロイ準備
- [ ] バックアップ作成
- [ ] ロールバック手順確認

---

## リスク管理

### 想定されるリスク

#### リスク 1: マイグレーション失敗
**影響度**: 高
**発生確率**: 低
**対策**:
- 事前にDBバックアップ
- 開発環境で十分にテスト
- ロールバック手順を用意

#### リスク 2: パフォーマンス劣化
**影響度**: 中
**発生確率**: 中
**対策**:
- 並列スキャンの実装
- インデックスの最適化
- キャッシング機構の検討

#### リスク 3: WebSocket接続問題
**影響度**: 低
**発生確率**: 低
**対策**:
- エラーハンドリングの強化
- 再接続ロジックの実装
- フォールバック（ポーリング）の検討

---

## デイリープログレス記録テンプレート

```markdown
## YYYY-MM-DD

### 完了したタスク
- [ ] Task X.X: タスク名

### 進行中のタスク
- [ ] Task X.X: タスク名（XX%完了）

### 課題・ブロッカー
- 課題1: 説明

### 明日の予定
- Task X.X: タスク名
```

---

## コミットメッセージガイドライン

### フォーマット
```
<type>(<scope>): <subject>

<body>

<footer>
```

### Type
- `feat`: 新機能
- `fix`: バグ修正
- `refactor`: リファクタリング
- `test`: テスト追加
- `docs`: ドキュメント更新
- `chore`: その他の変更

### 例
```
feat(db): add migration system for schema versioning

- Implement Migration interface
- Add schema_version table
- Create runMigrations() function

Implements part of Issue #2
```

---

## Phase 2 への展望（参考）

Phase 1 完了後、以下の機能を検討:

### 予定機能
1. **リポジトリ管理UI**
   - リポジトリの追加・削除
   - 有効/無効の切り替え
   - 設定画面

2. **メモの検索機能**
   - 全文検索
   - フィルタリング

3. **メモのMarkdown対応**
   - Markdown記法のサポート
   - プレビュー表示

4. **メモのタグ機能**
   - タグ付け
   - タグでのフィルタ

---

## まとめ

この実装計画に従うことで、Issue #2 の要件を段階的かつ確実に実装できます。各タスクは独立性が高く、並行作業も可能です。チェックリストを活用して進捗を管理し、品質を担保しながら進めましょう。
