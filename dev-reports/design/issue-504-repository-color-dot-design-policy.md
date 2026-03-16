# 設計方針書: サイドバーリポジトリ色付きドット（Issue #504）

## 1. 概要

サイドバーのリポジトリグループヘッダーに、リポジトリ名からハッシュベースで生成した一意の色付きドットを表示する機能を追加する。

### 目的
- リポジトリの視覚的識別性を向上させ、ユーザーの認知負荷を低減する
- リポジトリ数が増加しても素早く目的のグループを見つけられるようにする

### スコープ
- 色生成ユーティリティ関数の追加（`sidebar-utils.ts`）
- `GroupHeader`コンポーネントへの色付きドット追加（`Sidebar.tsx`）
- ユニットテストの追加（`sidebar-utils.test.ts`）

---

## 2. アーキテクチャ設計

### システム構成

```
src/lib/sidebar-utils.ts          ← 色生成関数を追加（純粋関数）
        ↓ import
src/components/layout/Sidebar.tsx  ← GroupHeaderで色ドットを表示
        ↓ renders
GroupHeader → [ColorDot] + [GroupIcon] + [RepoName] + [Count]
```

### レイヤー構成

| レイヤー | ファイル | 変更内容 |
|---------|---------|---------|
| ユーティリティ | `src/lib/sidebar-utils.ts` | `generateRepositoryColor()` 関数追加 |
| プレゼンテーション | `src/components/layout/Sidebar.tsx` | `GroupHeader`に色ドット要素追加 |
| テスト | `tests/unit/lib/sidebar-utils.test.ts` | テストケース追加 |

### 依存関係

- 新規依存ライブラリ: **なし**（標準的な文字列ハッシュとHSL計算のみ）
- 既存依存への影響: **なし**（additive changeのみ）

#### sidebar-utils.ts の依存先一覧（DR3-003）

| ファイル | 依存内容 | 今回の変更による影響 |
|---------|---------|-------------------|
| `src/components/layout/Sidebar.tsx` | sortBranches, groupBranches, generateRepositoryColor（新規） | **あり** - generateRepositoryColor を新たにimport |
| `src/components/sidebar/SortSelector.tsx` | SortKey, SortDirection 型のみ | **なし** - 既存エクスポートの変更なし |
| `src/contexts/SidebarContext.tsx` | SortKey, SortDirection, ViewMode 型 | **なし** - 既存エクスポートの変更なし |
| `tests/unit/lib/sidebar-utils.test.ts` | テスト対象 | **あり** - generateRepositoryColor のテスト追加 |

---

## 3. 技術設計

### 3.1 色生成アルゴリズム

#### ハッシュ関数

リポジトリ名文字列からシンプルなハッシュ値を算出する。djb2等の軽量ハッシュアルゴリズムを使用。

**`simpleHash`関数の公開範囲**: `simpleHash`はモジュール内プライベート関数（非エクスポート）として実装する。テストは`generateRepositoryColor`経由の結合テストで間接的にカバーする。将来的にハッシュ関数を他のモジュールで再利用する必要が生じた場合にのみエクスポートを検討する。（レビュー指摘 DR1-001）

```typescript
/**
 * リポジトリ名から一意の色をHSL形式で生成する
 * @param repositoryName - リポジトリ名
 * @returns HSLカラー文字列 (e.g., "hsl(210, 70%, 60%)")
 */
export function generateRepositoryColor(repositoryName: string): string {
  const hash = simpleHash(repositoryName);
  const hue = hash % 360;          // 0-359の色相
  const saturation = 65;            // 固定彩度（ダーク背景で映える値）
  const lightness = 60;             // 固定明度（ダーク背景で視認性確保）
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}
```

#### 設計判断

| 判断事項 | 採用案 | 理由 |
|---------|-------|------|
| ハッシュアルゴリズム | djb2系シンプルハッシュ | 軽量・決定論的・外部依存なし |
| カラースペース | HSL | hueのみ変動させれば自然な色分布が得られる |
| 彩度・明度 | 固定値（関数内名前付き定数） | ダーク背景固定のため、一組の値で十分。調整の余地を排除しシンプルに。マジックナンバー回避のため`REPO_DOT_SATURATION`、`REPO_DOT_LIGHTNESS`等の名前付き定数として定義する（DR1-002） |
| メモ化 | 不要（現時点） | GroupHeader再レンダリング時に毎回呼ばれるが計算コストが極めて低く、リポジトリ数も限定的（DR2-001） |

### 3.2 色ドットUI仕様

#### サイズ・形状

| プロパティ | 値 | 理由 |
|-----------|-----|------|
| サイズ | `w-2.5 h-2.5` (10px) | CLIステータスドット（w-2 h-2 = 8px）より大きく、一目で区別可能 |
| 形状 | `rounded-full` | 既存のドットUIと統一 |
| 配置 | GroupIcon（フォルダアイコン）の左 | 視線の流れに沿った自然な配置 |
| flex | `flex-shrink-0` | 縮小防止 |

#### GroupHeader レイアウト（変更後）

```
[Chevron] [ColorDot] [GroupIcon] [RepoName...truncate] [Count]
```

現在:
```
[Chevron] [GroupIcon] [RepoName...truncate] [Count]
```

#### モバイルドロワー幅での横幅検証（DR3-002）

モバイルドロワーは`AppShell.tsx`で`w-72`（288px）固定幅。GroupHeader内の各要素のサイズ内訳:

| 要素 | サイズ | 備考 |
|------|--------|------|
| px-4 パディング（左右） | 32px (16px x 2) | GroupHeaderのpadding |
| Chevron アイコン (w-3) | 12px | |
| ColorDot (w-2.5) **新規** | 10px | |
| gap-2 (Chevron-Dot間) | 8px | |
| GroupIcon (w-3) | 12px | |
| gap-2 (Dot-Icon間) | 8px | |
| gap-2 (Icon-Name間) | 8px | |
| Count 部分 | ~20px | 括弧+数字 |
| **合計固定幅** | **~110px** | |
| **RepoName利用可能幅** | **~178px** | 288px - 110px、truncateで収まる |

ColorDot追加により従来と比較して約18px（ドット10px + gap 8px）リポジトリ名のtruncate発動が早まるが、178pxの表示幅があれば十分な文字数を表示可能であり、機能上問題ない。長いリポジトリ名のtruncateが早期に発動することは許容範囲内である。

#### スタイル適用方法

```typescript
<span
  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
  style={{ backgroundColor: generateRepositoryColor(repositoryName) }}
/>
```

**インラインスタイル採用理由**: HSL値は動的に生成されるため、Tailwindのユーティリティクラスでは表現できない。`style`属性でbackgroundColorを直接指定する。なお、既存のCLIステータスドット（`CliStatusDot`）はTailwindクラス（`config.className`）で色を指定しており、`style={{ backgroundColor: ... }}`の使用は`src/components`配下で初のパターンとなる。動的HSL値を扱う技術的必要性からこの逸脱を許容する（DR2-003）。

### 3.3 CLIステータスドットとの差別化

| 属性 | リポジトリ色ドット | CLIステータスドット |
|------|------------------|-------------------|
| 配置場所 | GroupHeaderのグループヘッダー行 | BranchListItemのブランチ行 |
| サイズ | w-2.5 h-2.5 (10px) | w-2 h-2 (8px) |
| 色の意味 | リポジトリ識別（固定色） | 状態表示（状態により変化） |
| 色の決定方法 | ハッシュベース自動生成 | SIDEBAR_STATUS_CONFIGから取得 |

---

## 4. パフォーマンス設計

### 計算コスト

- `generateRepositoryColor`は文字列ハッシュ（O(n)、nは文字列長）+ 剰余演算のみ
- 典型的なリポジトリ名（10-50文字）では無視できるコスト
- `groupedBranches`は`useMemo`で保護されているが、`generateRepositoryColor`はGroupHeaderコンポーネントのJSXレンダリング中に呼び出されるため、useMemoの保護対象外である。GroupHeaderが再レンダリングされるたびに呼び出されるが、計算コストが極めて低い（文字列ハッシュ+剰余演算のみ）ため、パフォーマンス上の問題はない（DR2-001）

### メモ化方針

- **現時点**: メモ化不要（YAGNI原則）
- **将来**: リポジトリ数が100を超える場合、`useMemo`またはモジュールレベルキャッシュを検討

### バンドルサイズ影響（DR3-004）

- **影響**: 無視できるレベル
- `generateRepositoryColor`は約20行の純粋関数であり、外部ライブラリの追加なし
- `sidebar-utils.ts`はクライアントコンポーネント（`Sidebar.tsx`）からimportされるため、既存のクライアントバンドルに含まれる
- 追加のコード分割（code splitting）やtree-shakingへの影響なし

---

## 5. セキュリティ設計

### リスク評価

| リスク | 評価 | 対策 |
|-------|------|------|
| XSS | 低リスク | HSL値は数値のみで構成、文字列インジェクションの余地なし |
| prototype pollution | N/A | ハッシュ関数は入力文字列を数値に変換するのみ |
| DoS（巨大文字列） | 低リスク | リポジトリ名はGit由来で実質的に長さ制限あり |
| 入力バリデーション | 不要 | `repositoryName`は`path.basename(repositoryPath)`由来のサーバーサイド値であり、外部ユーザー入力ではない。`generateRepositoryColor`関数レベルの入力バリデーション（空文字チェック、長さ上限チェック等）は不要。空文字を含む任意の文字列で正常動作する設計とする（DR4-006） |

---

## 6. テスト戦略

### ユニットテスト（`tests/unit/lib/sidebar-utils.test.ts`に追加）

| テストケース | 期待結果 |
|-------------|---------|
| 同一リポジトリ名で同一色（冪等性） | `generateRepositoryColor('repo-a') === generateRepositoryColor('repo-a')` |
| 異なるリポジトリ名で異なるハッシュ値から算出されたhue値 | `parseHue('repo-a') !== parseHue('repo-b')`（注: ハッシュ衝突やhue近接は確率的に発生しうるため、テスト用の入力値は事前に衝突しないことを確認した値を使用する）（DR1-003） |
| 空文字列でエラーなし | 例外が発生せず、有効なHSL文字列を返す |
| 特殊文字を含む名前で正常動作 | 日本語、記号、スペースを含む名前で有効なHSL |
| 返り値がHSL形式 | `/^hsl\(\d+, \d+%, \d+%\)$/` にマッチ |

### 手動確認項目

- モバイルドロワー幅（w-72）でのレイアウト崩れなし
- ダーク背景上での色の視認性
- 長いリポジトリ名でのtruncate動作

---

## 7. 設計上の決定事項とトレードオフ

### 採用した設計

| 決定事項 | 採用案 | 代替案 | トレードオフ |
|---------|-------|-------|-------------|
| 色生成方式 | ハッシュベース自動生成 | ユーザー手動設定 | 設定UIが不要でシンプル、ただしユーザーが色を選べない |
| カラースペース | HSL（hueのみ変動） | RGB | HSLの方がhue変動だけで自然な色分布、RGBは計算が複雑 |
| 配置先ファイル | sidebar-utils.ts | 新規ファイル | 既存ファイルの責務に合致、新規ファイル不要でシンプル |
| 彩度・明度 | 固定値 | hue依存で動的調整 | 固定値でシンプル、ダーク背景固定なので十分 |
| フォルダアイコン | 維持（ドットと併存） | ドットで置換 | アイコンの視覚的手がかりを保持 |
| hue近接による色の類似 | 許容する | 衝突回避アルゴリズム | リポジトリ数が少数であり、完全な衝突回避は複雑性が大幅に増す。hue差が小さい場合に色が類似して見えることは許容範囲内とする（DR1-003） |
| `generateRepositoryColor`の呼び出し箇所 | GroupHeader内部で直接呼び出し | 親コンポーネントからpropsで渡す | OCP観点では親からprops渡しが望ましいが、現時点の実装規模ではKISSを優先しGroupHeader内部での直接呼び出しで十分。将来的にcolor算出ロジックが複雑化した場合にprops渡しへリファクタリングする（DR1-005） |

### 不採用にした代替案

1. **アバター/イニシャル表示**: 実装コストが高く、スペースも取る。ドットの方がコンパクト
2. **色付きボーダー**: グループヘッダーの上下ボーダーに色を付ける案。視認性は良いがデザインの一貫性に欠ける
3. **Tailwind arbitrary values**: `bg-[hsl(...)]`形式も可能だが、テンプレートリテラルとの組み合わせが読みにくい。インラインスタイルの方が明快
4. **ライトテーマ対応**: 現時点ではダーク背景固定のため対応しない（YAGNI原則に基づく意識的な除外判断）。将来ライトテーマを導入する場合は、彩度・明度パラメータをテーマに応じて切り替える拡張が必要となる。（レビュー指摘 DR1-004）

---

## 8. 実装計画

### ステップ

1. `sidebar-utils.ts`に`generateRepositoryColor`関数を追加
2. `sidebar-utils.test.ts`にテストケースを追加（RED）
3. テストがパスするよう実装を調整（GREEN）
4. `Sidebar.tsx`の`GroupHeader`に色ドット要素を追加
5. lint / tsc / test:unit を実行して品質確認

### 変更ファイル一覧

| ファイル | 変更種別 | 変更量（見込み） |
|---------|---------|----------------|
| `src/lib/sidebar-utils.ts` | 修正 | +20行程度 |
| `src/components/layout/Sidebar.tsx` | 修正 | +5行程度（import文に`generateRepositoryColor`追加 + 色ドット要素追加）（DR2-002） |
| `tests/unit/lib/sidebar-utils.test.ts` | 修正 | +40行程度 |
| `tests/unit/components/layout/Sidebar.test.tsx` | 確認対象（変更不要の見込み） | 既存テストがGroupHeaderのDOM変更後も引き続きパスすることを確認する。テストはdata-testidベースのクエリを使用しておりDOM構造に依存していないため、変更は不要の見込み（DR3-001） |

---

## 9. レビュー指摘事項サマリー（Stage 1: 通常レビュー）

### 対応済み指摘事項

| ID | 重要度 | タイトル | 対応内容 |
|----|--------|---------|---------|
| DR1-001 | should_fix | simpleHash関数のエクスポート可否とテスト可能性 | セクション3.1に`simpleHash`を非エクスポート（プライベート）とする方針を明記。テストは`generateRepositoryColor`経由で実施 |
| DR1-004 | should_fix | ライトテーマ対応の除外判断 | セクション7の不採用代替案にライトテーマ非対応をYAGNI原則に基づく意識的決定として追記 |
| DR1-002 | nice_to_have | HSL固定値のマジックナンバー | セクション3.1の設計判断表に名前付き定数（`REPO_DOT_SATURATION`等）の使用方針を追記 |
| DR1-003 | nice_to_have | 色衝突（hue近接）への言及 | セクション7のトレードオフ表にhue近接の許容方針を追記。セクション6のテストケース記述を修正 |
| DR1-005 | nice_to_have | GroupHeaderでのgenerateRepositoryColor呼び出し箇所 | セクション7のトレードオフ表にGroupHeader内部での直接呼び出し方針を追記 |

### 実装チェックリスト（レビュー指摘反映）

- [ ] `simpleHash`関数を`export`せずモジュール内プライベートとして実装する（DR1-001）
- [ ] 彩度・明度の固定値を関数内名前付き定数（`REPO_DOT_SATURATION`, `REPO_DOT_LIGHTNESS`等）として定義する（DR1-002）
- [ ] テストケース「異なるリポジトリ名で異なるhue値」で使用する入力値が衝突しないことを事前確認する（DR1-003）
- [ ] `generateRepositoryColor`をGroupHeader内部で直接呼び出す形で実装する（DR1-005）

---

## 10. レビュー指摘事項サマリー（Stage 2: 整合性レビュー）

### 対応済み指摘事項

| ID | 重要度 | タイトル | 対応内容 |
|----|--------|---------|---------|
| DR2-001 | should_fix | useMemo保護に関する記述が不正確 | セクション4のパフォーマンス設計を修正。`generateRepositoryColor`はuseMemoの保護対象外であり、GroupHeader再レンダリング時に毎回呼ばれるが計算コストが無視できるため問題ない旨を正確に記載。セクション3.1の設計判断表も合わせて修正 |
| DR2-002 | nice_to_have | Sidebar.tsxのimport文変更が未記載 | セクション8の変更ファイル一覧にimport文への`generateRepositoryColor`追加を明記 |
| DR2-003 | nice_to_have | インラインstyle属性がコードベース初のパターン | セクション3.2に既存CLIステータスドットとのスタイル適用方法の違いと、本パターン採用の技術的理由を追記 |

### 対応不要（info）

| ID | タイトル | 判定理由 |
|----|---------|---------|
| DR2-004 | GroupHeader/GroupIcon/ChevronIconの構造記述は正確 | 設計書の記述が実装と一致していることの確認。対応不要 |
| DR2-005 | CLIステータスドットの仕様記述は正確 | 設計書の記述が実装と一致していることの確認。対応不要 |
| DR2-006 | テスト戦略は既存テストパターンと整合 | 既存パターンとの整合性確認。対応不要 |
| DR2-007 | sidebar-utils.tsの既存エクスポートとの整合性確認済み | additive changeであり既存APIに影響なし。対応不要 |

### 実装チェックリスト（Stage 2 レビュー指摘反映）

- [ ] `generateRepositoryColor`がGroupHeader再レンダリング時に毎回呼ばれることを理解した上で実装する（メモ化不要）（DR2-001）
- [ ] `Sidebar.tsx`のimport文に`generateRepositoryColor`を追加する（DR2-002）
- [ ] `style={{ backgroundColor: ... }}`がコンポーネント配下で初のインラインスタイルパターンであることをPRレビュー時に留意する（DR2-003）

---

## 11. レビュー指摘事項サマリー（Stage 3: 影響分析レビュー）

### 対応済み指摘事項

| ID | 重要度 | タイトル | 対応内容 |
|----|--------|---------|---------|
| DR3-001 | should_fix | Sidebar.test.tsxへの影響が変更ファイル一覧に未記載 | セクション8の変更ファイル一覧に`tests/unit/components/layout/Sidebar.test.tsx`を「確認対象（変更不要の見込み）」として追記。data-testidベースのテストのためDOM変更による破壊リスクは低いが、影響範囲として認識し確認ステップに含める |
| DR3-002 | should_fix | モバイルドロワーでの色ドット表示に関する影響分析が不足 | セクション3.2にモバイルドロワー幅（288px）での各要素サイズ内訳と検証結果を追記。ColorDot追加により約18pxリポジトリ名幅が減少するが、178pxの表示幅で十分と判断 |
| DR3-003 | nice_to_have | sidebar-utils.tsの間接影響確認が未記載 | セクション2の依存関係にsidebar-utils.tsの全依存先（Sidebar.tsx, SortSelector.tsx, SidebarContext.tsx, sidebar-utils.test.ts）を列挙し、影響有無を明記 |
| DR3-004 | nice_to_have | バンドルサイズへの影響評価が記載されていない | セクション4に「バンドルサイズ影響」サブセクションを追加。約20行の純粋関数追加のみで外部ライブラリなし、既存クライアントバンドルに含まれるため影響なしと明記 |

### 対応不要（info）

| ID | タイトル | 判定理由 |
|----|---------|---------|
| DR3-005 | 後方互換性に問題なし | すべてadditive changeであり後方互換性が維持されていることの確認。対応不要 |
| DR3-006 | 既存機能の破壊リスクは極めて低い | DOM構造変更が既存テスト・レイアウトに影響しないことの確認。対応不要 |

### 実装チェックリスト（Stage 3 レビュー指摘反映）

- [ ] GroupHeaderへの色ドット追加後、`tests/unit/components/layout/Sidebar.test.tsx`の全テスト（7箇所のGroupHeader関連テスト）がパスすることを確認する（DR3-001）
- [ ] モバイルドロワー幅（w-72 = 288px）で色ドット付きGroupHeaderのレイアウトが崩れないことを手動確認する（DR3-002）
- [ ] `sidebar-utils.ts`の既存エクスポート（sortBranches, groupBranches等）に変更がないことを確認する（DR3-003）

---

## 12. レビュー指摘事項サマリー（Stage 4: セキュリティレビュー）

### 対応済み指摘事項

| ID | 重要度 | タイトル | 対応内容 |
|----|--------|---------|---------|
| DR4-006 | nice_to_have | generateRepositoryColorに対する入力バリデーションの明示的記載 | セクション5のリスク評価表に「入力バリデーション」行を追加。`repositoryName`が`path.basename`由来のサーバーサイド値であり、関数レベルの入力バリデーションは不要である旨を明記 |

### 対応不要（info）

| ID | タイトル | 判定理由 |
|----|---------|---------|
| DR4-001 | inline style={{ backgroundColor }} はXSSリスクなし | HSL値は数値演算のみで構成され、ReactのstyleプロパティはCSSOМ経由で適用されるためXSSリスクなし。対応不要 |
| DR4-002 | repositoryNameの入力源は安全 | path.basename由来のサーバーサイド値であり、Reactの自動エスケープも有効。対応不要 |
| DR4-003 | djb2ハッシュ関数に暗号学的悪用リスクなし | 視覚的識別目的のみで暗号学的用途に使用されていない。対応不要 |
| DR4-004 | HSL文字列生成にインジェクションリスクなし | 全パラメータがnumber型であり文字列注入経路なし。対応不要 |
| DR4-005 | 新たな攻撃面の追加なし | クライアントサイドの表示ロジック追加のみ。対応不要 |

### OWASP Top 10 準拠状況

| カテゴリ | 判定 | 備考 |
|---------|------|------|
| A01: Broken Access Control | N/A | アクセス制御への影響なし |
| A02: Cryptographic Failures | Pass | ハッシュ関数は視覚的識別目的のみ |
| A03: Injection | Pass | 数値演算のみ、外部入力注入経路なし |
| A04: Insecure Design | Pass | 純粋関数による決定論的色生成 |
| A05: Security Misconfiguration | N/A | 設定変更なし |
| A06: Vulnerable Components | Pass | 外部ライブラリ追加なし |
| A07: Auth Failures | N/A | 認証フロー変更なし |
| A08: Data Integrity Failures | N/A | データ永続化変更なし |
| A09: Logging Failures | N/A | ログ機構変更なし |
| A10: SSRF | N/A | サーバーサイドリクエスト追加なし |

### セキュリティ総合評価

セキュリティリスクは極めて低い。本変更はクライアントサイドの純粋な表示ロジック追加であり、新たな攻撃面を導入しない。HSL色生成は数値演算のみで構成され、外部入力の注入経路が存在しない。OWASP Top 10の全カテゴリにおいて問題なし。

### 実装チェックリスト（Stage 4 レビュー指摘反映）

- [ ] `generateRepositoryColor`関数に入力バリデーション（空文字チェック、長さ上限チェック等）を追加しないこと。空文字を含む任意の文字列で正常動作する設計とする（DR4-006）

---

*Generated by design-policy command for Issue #504*
