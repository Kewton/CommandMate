# アーキテクチャレビュー: Issue #56 スラッシュコマンド対応

## レビュー情報
- **レビュー日**: 2026-01-25
- **対象**: `dev-reports/design/issue-56-design-policy.md`
- **Issue**: #56 - Claude Code標準スラッシュコマンドを利用出来るようにする
- **レビュアー**: シニアソフトウェアアーキテクト

---

## 1. 設計原則の遵守確認

### SOLID原則チェック

| 原則 | 状態 | 評価 |
|------|------|------|
| **S**ingle Responsibility | ✅ | 各モジュールが明確な責任を持つ（standard-commands.ts, slash-commands.ts） |
| **O**pen/Closed | ✅ | 新規カテゴリ追加が拡張で対応可能、既存コードの修正最小限 |
| **L**iskov Substitution | ✅ | SlashCommand型が一貫して使用可能 |
| **I**nterface Segregation | ✅ | SlashCommandSelectorPropsにonFreeInput追加は適切 |
| **D**ependency Inversion | ✅ | 抽象（型定義）に依存、具体実装は分離 |

### その他の原則

| 原則 | 状態 | コメント |
|------|------|---------|
| KISS | ✅ | 自由入力モードはシンプルな解決策 |
| YAGNI | ✅ | 必要最小限の機能に絞られている |
| DRY | ⚠️ | 標準コマンドの静的定義は重複リスクあり（後述） |

---

## 2. アーキテクチャ評価

### 構造的品質

| 評価項目 | スコア | コメント |
|---------|--------|----------|
| モジュール性 | 4/5 | 適切に分離されている |
| 結合度 | 4/5 | 低結合を維持 |
| 凝集度 | 4/5 | 関連機能がまとまっている |
| 拡張性 | 5/5 | 新規コマンドカテゴリの追加が容易 |
| 保守性 | 4/5 | 標準コマンドの手動更新が懸念 |

### パフォーマンス観点

| 項目 | 評価 | コメント |
|------|------|---------|
| レスポンスタイム | ✅ 良好 | 静的定義により高速 |
| スループット | ✅ 良好 | API呼び出し最小化 |
| リソース使用効率 | ✅ 良好 | メモリキャッシュ活用 |
| スケーラビリティ | ✅ 良好 | worktree数増加に対応可能 |

---

## 3. セキュリティレビュー

### OWASP Top 10 チェック

| 項目 | 状態 | 対応 |
|------|------|------|
| インジェクション対策 | ✅ | コマンド名のバリデーション計画あり |
| 認証の破綻対策 | N/A | 認証不要の機能 |
| 機微データの露出対策 | ✅ | コマンド情報のみ、機微データなし |
| XXE対策 | N/A | XML未使用 |
| アクセス制御の不備対策 | ⚠️ | worktreeパスの検証が必要 |
| セキュリティ設定ミス対策 | ✅ | デフォルト設定が安全 |
| XSS対策 | ✅ | React使用、自動エスケープ |
| 安全でないデシリアライゼーション対策 | N/A | 該当なし |
| 既知の脆弱性対策 | ✅ | 依存パッケージの定期更新が前提 |
| ログとモニタリング不足対策 | ⚠️ | エラーログは記載あり、監視は未記載 |

### セキュリティ改善提案

```typescript
// worktree.pathの検証を追加
function validateWorktreePath(path: string): boolean {
  // パストラバーサル防止
  if (path.includes('..') || !path.startsWith('/')) {
    return false;
  }
  // 許可されたディレクトリ配下か確認
  const allowedBasePaths = ['/Users/maenokota/share/work'];
  return allowedBasePaths.some(base => path.startsWith(base));
}
```

---

## 4. 既存システムとの整合性

### 統合ポイント

| 項目 | 状態 | コメント |
|------|------|---------|
| API互換性 | ✅ | 既存API維持、新規APIは追加 |
| データモデル整合性 | ✅ | SlashCommand型を拡張（後方互換） |
| 認証/認可の一貫性 | N/A | 認証不要 |
| ログ/監視の統合 | ✅ | 既存のconsole.errorを使用 |

### 技術スタックの適合性

| 項目 | 状態 | コメント |
|------|------|---------|
| 既存技術との親和性 | ✅ | Next.js 14, TypeScript, React hooks |
| チームのスキルセット | ✅ | 既存パターンの延長 |
| 運用負荷への影響 | ✅ | 最小限（標準コマンドの定期更新のみ） |

---

## 5. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|--------|---------|-----------|
| 技術的リスク | 標準コマンド一覧の陳腐化 | 低 | 中 | 低 |
| 技術的リスク | worktreeパス検証の不備 | 中 | 低 | 中 |
| 運用リスク | コマンド重複時の挙動 | 低 | 低 | 低 |
| UXリスク | 自由入力の使いにくさ | 中 | 中 | 中 |
| 保守リスク | カテゴリ増加による複雑性 | 低 | 低 | 低 |

### リスク詳細と対策

#### リスク1: 標準コマンド一覧の陳腐化

**状況**: Claude Codeの更新で新コマンドが追加された場合、静的定義が古くなる

**対策**:
- 自由入力モードで新コマンドも使用可能（軽減済み）
- 定期的な標準コマンドリストの見直しをメンテナンスタスクに追加
- Claude Codeリリースノートのウォッチ

#### リスク2: 自由入力の使いにくさ

**状況**: モバイルでコマンド名を正確に入力する必要がある

**対策**:
- 入力履歴の保存機能を検討（将来）
- オートコンプリート機能を検討（将来）
- よく使うコマンドを上部に固定表示（設計済み）

---

## 6. 改善提案

### 必須改善項目（Must Fix）

#### MF-1: worktreeパスのバリデーション強化

```typescript
// src/app/api/worktrees/[id]/slash-commands/route.ts

export async function GET(request: NextRequest, { params }) {
  const worktree = await getWorktreeById(params.id);

  if (!worktree) {
    return NextResponse.json({ error: 'Worktree not found' }, { status: 404 });
  }

  // 追加: パス検証
  if (!isValidWorktreePath(worktree.path)) {
    console.error(`Invalid worktree path: ${worktree.path}`);
    return NextResponse.json({ error: 'Invalid worktree' }, { status: 400 });
  }

  // ...
}
```

### 推奨改善項目（Should Fix）

#### SF-1: コマンド重複時の優先順位を明確化

設計書に以下を追記推奨：

```typescript
// コマンド優先順位（同名コマンドがある場合）
// 1. Worktree固有コマンド（プロジェクト固有の上書き）
// 2. 標準コマンド

function mergeCommandGroups(
  standardGroups: SlashCommandGroup[],
  worktreeGroups: SlashCommandGroup[]
): SlashCommandGroup[] {
  // worktreeコマンドが優先（同名は上書き）
  const commandMap = new Map<string, SlashCommand>();

  // 標準コマンドを先に登録
  standardGroups.flatMap(g => g.commands).forEach(cmd => {
    commandMap.set(cmd.name, cmd);
  });

  // worktreeコマンドで上書き
  worktreeGroups.flatMap(g => g.commands).forEach(cmd => {
    commandMap.set(cmd.name, { ...cmd, source: 'worktree' });
  });

  // グループ化して返す
  return groupByCategory(Array.from(commandMap.values()));
}
```

#### SF-2: エラーハンドリングの統一

```typescript
// src/lib/api-errors.ts（新規または既存に追加）

export class SlashCommandError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'INVALID_PATH' | 'LOAD_FAILED',
    public statusCode: number
  ) {
    super(message);
    this.name = 'SlashCommandError';
  }
}
```

### 検討事項（Consider）

#### C-1: 入力履歴機能

**将来検討**: よく使うコマンドを学習して上位に表示

```typescript
// localStorage活用案
interface CommandHistory {
  name: string;
  usageCount: number;
  lastUsed: string;
}

function useCommandHistory() {
  const [history, setHistory] = useState<CommandHistory[]>([]);

  const recordUsage = (commandName: string) => {
    // 使用履歴を記録
  };

  const getSortedCommands = (commands: SlashCommand[]) => {
    // 使用頻度順にソート
  };

  return { recordUsage, getSortedCommands };
}
```

#### C-2: 標準コマンドの自動更新

**将来検討**: Claude Codeのバージョンから標準コマンドを推測

```typescript
// 注: Claude Code APIが提供された場合の将来構想
async function fetchStandardCommands(): Promise<SlashCommand[]> {
  // /help コマンドの出力をパースする等
  // 現時点ではAPIが未提供のため静的定義を使用
}
```

---

## 7. ベストプラクティスとの比較

### 業界標準との差異

| 項目 | 業界標準 | 本設計 | 評価 |
|------|---------|--------|------|
| コマンドパレット | VSCode式 | ボトムシート | ✅ モバイル向けに適切 |
| オートコンプリート | 一般的 | 検索のみ | △ 将来検討 |
| キーボードショートカット | 一般的 | `/`キー | ✅ デスクトップ対応済み |
| 履歴機能 | 一般的 | 未実装 | △ 将来検討 |

### 代替アーキテクチャ案

#### 代替案1: コマンドレジストリパターン

```typescript
// すべてのコマンドを一元管理するレジストリ
class CommandRegistry {
  private commands: Map<string, SlashCommand> = new Map();

  register(command: SlashCommand) { /* ... */ }
  unregister(name: string) { /* ... */ }
  getAll(): SlashCommand[] { /* ... */ }
}

// グローバルインスタンス
export const commandRegistry = new CommandRegistry();
```

**メリット**: 動的な登録・解除が可能
**デメリット**: 複雑性増加、現状では過剰
**評価**: 現設計で十分、将来拡張時に検討

#### 代替案2: プラグインアーキテクチャ

**メリット**: 高い拡張性
**デメリット**: 大幅な設計変更が必要
**評価**: 現時点では不要

---

## 8. 総合評価

### レビューサマリ

| 項目 | 評価 |
|------|------|
| **全体評価** | ⭐⭐⭐⭐☆（4/5） |
| **設計品質** | 良好 |
| **実装難易度** | 低〜中 |
| **リスク** | 低 |

### 強み

1. **シンプルな解決策**: 自由入力モードで「自動対応」要件を満たす
2. **段階的実装**: Phase 1〜3に分割され、リスク分散
3. **後方互換性**: 既存APIを維持、追加のみ
4. **拡張性**: 新規カテゴリの追加が容易

### 弱み

1. **標準コマンドの手動更新**: 静的定義のため陳腐化リスク
2. **モバイルUX**: 自由入力はやや使いにくい可能性
3. **パス検証**: セキュリティ対策の詳細が不足

### 総評

本設計は、Issue #56の要件を適切に分析し、現実的かつ段階的な解決策を提示しています。特に「自由入力モード」の追加により、「自動対応」という難しい要件を elegantly に解決しています。

Phase 1（自由入力モード）を最優先としたことは正しい判断です。これにより、最小限の実装で最大の効果を得られます。

---

## 9. 承認判定

### 判定: ✅ 条件付き承認（Conditionally Approved）

### 承認条件

1. **MF-1**: worktreeパスのバリデーション強化を実装計画に追加
2. **SF-1**: コマンド重複時の優先順位を設計書に明記

### 次のステップ

1. [ ] 上記2点を設計書に追記
2. [ ] Phase 1（自由入力モード）の実装着手
3. [ ] 実装完了後、Phase 2へ進行

---

## 10. レビュー履歴

| 日時 | レビュアー | アクション |
|------|-----------|-----------|
| 2026-01-25 | シニアアーキテクト | 初回レビュー、条件付き承認 |
