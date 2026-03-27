# 設計方針書: Issue #549 スマホ版Markdownファイル初期表示をビューワに変更

## 1. 概要

### 目的
モバイル（768px未満）でMarkdownファイルを開いた際、MarkdownEditorの初期表示タブをeditorからpreview（ビューワ）に変更する。

### 背景
- モバイルユーザーはMarkdownファイルをプレビュー（閲覧）目的で開くケースがほとんど
- 現状はMarkdownEditor起動時にeditorタブがデフォルトで、previewに切り替えるために追加タップが必要
- PC版の動作は変更しない

## 2. アーキテクチャ設計

### 変更スコープ

```
src/components/worktree/MarkdownEditor.tsx  ← mobileTab初期値変更（メイン変更）
src/components/worktree/WorktreeDetailRefactored.tsx  ← initialViewMode='split'明示
```

### 変更しないファイル

| ファイル | 理由 |
|---------|------|
| `src/types/markdown-editor.ts` | 型定義・定数に変更不要 |
| `src/components/worktree/MarkdownPreview.tsx` | MobileTabBarはprops受取のみ |
| `src/components/worktree/FilePanelContent.tsx` | PC側パネル。MarpRenderableMarkdown内でinitialViewMode='split'、MarkdownWithSearch内でinitialViewMode='preview'を渡している。いずれもPC側のため変更不要 |
| `src/components/worktree/FileViewer.tsx` | 変更影響外 |
| `src/hooks/useIsMobile.ts` | 既存ロジックをそのまま利用 |

### コンポーネント関係図

```
WorktreeDetailRefactored
  ├── [Desktop] FilePanelContent
  │     ├── MarpRenderableMarkdown → MarkdownEditor (initialViewMode='split')
  │     └── MarkdownWithSearch → MarkdownEditor (initialViewMode='preview')
  ├── [Desktop] Modal → MarkdownEditor (initialViewMode未指定 → localStorage/デフォルト)
  └── [Mobile] Modal → MarkdownEditor (initialViewMode='split' ← 今回追加)
                          ├── viewMode: 'split' (MobileTabBar表示のため)
                          ├── mobileTab: 'preview' ← useEffectで設定（今回の変更）
                          └── MobileTabBar (editor | preview タブ切替)
```

> **注**: Desktop FilePanelContent内には2つのMarkdownEditor呼び出しパスがある。Desktop Modalパス（WorktreeDetailRefactored.tsx line 1597）はinitialViewMode未指定でlocalStorage/デフォルト値が適用される。いずれも今回の変更スコープ外。

## 3. 技術選定・設計パターン

### 採用パターン: useEffectによる遅延初期化

**理由**: `useIsMobile` hookがSSRハイドレーション安全性のため初期値`false`を返すため、`useState`の初期値では正しいモバイル判定ができない。

```typescript
// MarkdownEditor.tsx 内

// 初期値は'editor'のまま（SSR安全）
const [mobileTab, setMobileTab] = useState<MobileTab>('editor');

// isMobileがtrueになった時点でpreviewに切り替え
useEffect(() => {
  if (isMobile) {
    setMobileTab('preview');
  }
}, [isMobile]);
```

### 設計判断とトレードオフ

| 決定事項 | 理由 | トレードオフ |
|---------|------|-------------|
| useEffectベースの初期化 | SSRハイドレーション安全性 | 初回レンダリングで一瞬editorが表示される可能性（モーダルアニメーション中に完了するため体感なし） |
| viewMode='split'維持 | MobileTabBarのtab切替機能を保持 | viewMode='preview'にすればMobileTabBar不要だがエディタへの切替不可になる |
| localStorage無視（モバイル） | モバイルでは常にpreview初期表示を保証 | ユーザーのeditor設定がセッション跨ぎで保持されない |
| filePath変更時にmobileTab非リセット | ユーザーのタブ選択を尊重 | 別ファイルを開いてもeditorタブのまま |

### 代替案（不採用）

| 代替案 | 不採用理由 |
|--------|----------|
| `useState(isMobile ? 'preview' : 'editor')` | SSR初期値falseにより常にeditorになる |
| viewMode自体を'preview'に変更 | MobileTabBarが表示されずtab切替不可 |
| モバイル専用localStorageキー | 過剰設計（YAGNI） |
| FilePanelContent側で制御 | モバイルModalパスはFilePanelContentを経由しない |

## 4. データモデル設計

データベース変更なし。

### 状態管理

| 状態 | 保存先 | モバイル時 | PC時 |
|------|--------|----------|------|
| viewMode | localStorage (`commandmate:md-editor-view-mode`) | initialViewMode='split'で上書き | localStorage復元 |
| mobileTab | コンポーネントstate | useEffectで'preview'に設定 | 使用されない（showMobileTabs=false） |
| isMobile | useIsMobile hook | true（viewport < 768px） | false |

## 5. API設計

API変更なし。フロントエンドのみの変更。

## 6. セキュリティ設計

セキュリティへの影響なし。
- 表示モードの切替のみでデータフローに変更なし
- XSS対策（rehype-sanitize）はMarkdownPreview側で既に適用済み
- ユーザー入力の新規追加なし

## 7. パフォーマンス設計

### 影響分析

- **レンダリング**: useEffectによるmobileTab設定は1回のみ（isMobile依存）。再レンダリングコスト微小
- **メモリ**: 追加のstate/refなし（既存のmobileTab stateを活用）
- **ネットワーク**: 影響なし

### モーダルフラッシュ対策

useEffectはReactのcommitフェーズ後に実行されるため、理論上は初回レンダリングでeditorが一瞬表示される。ただし：
1. MarkdownEditorはModal内で表示される
2. Modalのopen animationの間にuseEffectが完了する
3. MarkdownEditorのisLoadingステートが初期表示中はtrueのため、実際のeditor/previewコンテンツはローディング中で見えない

→ 体感上の影響はないが、実装後に実機確認が必要。

### モバイル固有フックとの相互作用 (Stage 3 NH-002)

MarkdownEditor で使用される他のモバイル固有フックは今回の変更と独立している：

| フック | 役割 | mobileTab との関係 |
|--------|------|-------------------|
| `useSwipeGesture` | 最大化モード時の下スワイプ解除 | 独立（mobileTab を参照しない） |
| `useVirtualKeyboard` | 仮想キーボード表示時の padding 調整 | 独立（mobileTab を参照しない） |

これらのフックは mobileTab の初期値変更とは直交する機能であり、相互作用は発生しない。

## 8. テスト設計

### ユニットテスト

| テストケース | 検証内容 |
|-------------|---------|
| モバイルデフォルトpreview | useIsMobile=trueでmobileTab='preview'になること |
| PCデフォルト変更なし | useIsMobile=falseでmobileTab='editor'のままであること |
| localStorage上書き防止 | モバイルでlocalStorageにviewMode='editor'があってもpreviewが初期表示 |
| filePath変更時のtab維持 | editorに切替後、filePath変更でmobileTabがeditorのまま |
| WorktreeDetailRefactored props | モバイルModal経由でinitialViewMode='split'が渡されること |

### モック戦略

```typescript
// useIsMobile hookのモック（MOBILE_BREAKPOINTも含める - プロジェクト既存パターン準拠）
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => true), // モバイル
  MOBILE_BREAKPOINT: 768,
}));
```

## 9. 実装方針

### 変更1: MarkdownEditor.tsx

**場所**: `mobileTab` state宣言の直後（現在の134行目付近）

```typescript
// 既存（変更なし）
const [mobileTab, setMobileTab] = useState<MobileTab>('editor');

// 追加: モバイル時にpreviewタブをデフォルトに
useEffect(() => {
  if (isMobile) {
    setMobileTab('preview');
  }
}, [isMobile]);
```

**注意点**:
- `isMobile`が`false`→`true`に変わった時のみ発火
- `else`ブランチ不要（`showMobileTabs`が`false`になりMobileTabBar非表示）
- `filePath`は依存配列に含めない（ユーザーのタブ選択を尊重）
- `filePath`変更時は`loadContent`が再実行され`isLoading=true`となるため、`mobileTab`の値に関わらずローディング表示が優先される。これにより`filePath`を依存配列から除外しても安全である（Stage 3 NH-001）

### 変更2: WorktreeDetailRefactored.tsx

**場所**: モバイルレイアウトのMarkdownEditor呼び出し（現在の1869行目付近）

```tsx
<MarkdownEditor
  worktreeId={worktreeId}
  filePath={editorFilePath}
  onClose={handleEditorClose}
  onSave={handleEditorSave}
  onMaximizedChange={setIsEditorMaximized}
  initialViewMode="split"  // ← 追加
/>
```

**理由**: `initialViewMode`未指定時、`getInitialViewMode()`がlocalStorageの値を返す。localStorageに`'editor'`が保存されていると`viewMode='editor'`となり、`showMobileTabs`が`false`になってMobileTabBarが表示されない。`'split'`を明示することでMobileTabBarが常に表示される。

## 10. レビュー指摘事項と設計判断

### Stage 1: 通常レビュー (score: 4/5, status: approved)

#### SF-001: useEffect の SRP (Single Responsibility) について

- **指摘内容**: MarkdownEditor は既に多くの責務を持つ大きなコンポーネントであり、mobileTab 初期化の useEffect を追加するとさらに責務が増える。`useInitialMobileTab(isMobile)` のような専用 hook への抽出を検討すべき。
- **設計判断**: **現行のインライン実装を維持する**
- **根拠**:
  1. 該当 useEffect は 2 行（if 文 + setMobileTab）であり、専用 hook 化するとファイル作成・import 追加のオーバーヘッドが抽出対象のコードより大きい
  2. mobileTab state は MarkdownEditor 内のローカル state であり、外部からの利用は想定されない。hook に切り出しても再利用性の向上は見込めない
  3. KISS/YAGNI の観点から、現時点で 2 行のロジックを独立ファイルに分離する必然性がない
  4. MarkdownEditor の責務が今後さらに増加する場合は、mobileTab 関連に限らずコンポーネント全体のリファクタリングを検討すべき（その際に hook 抽出も含めて判断する）
- **再検討トリガー**: MarkdownEditor 内のモバイル固有ロジックが 3 箇所以上に増えた場合、`useMobileEditorBehavior` のような包括的な hook への抽出を検討する

#### SF-002: initialMobileTab prop の追加について

- **指摘内容**: useEffect + initialViewMode の 2 箇所変更は密結合であり、`initialMobileTab` prop を EditorProps に追加すれば useState の初期値として使え、useEffect が不要になる。
- **設計判断**: **現行の useEffect アプローチを維持する**
- **根拠**:
  1. `initialMobileTab` prop を追加しても SSR ハイドレーション問題は解消されない。`useIsMobile` が初期値 `false` を返すため、呼び出し側で `isMobile ? 'preview' : 'editor'` と書いても SSR 時は常に `'editor'` になる
  2. つまり prop 追加だけでは問題を解決できず、結局 useEffect も必要になるか、呼び出し側に同等のロジックが移動するだけ
  3. 現行設計では MarkdownEditor が自律的にモバイル対応を行うため、呼び出し側は `initialViewMode='split'` を渡すだけで済む。モバイル判定ロジックが呼び出し側に漏洩しない
  4. EditorProps に使用場面の限られた optional prop を増やすと、インターフェースが肥大化する（ISP の観点）
- **再検討トリガー**: MarkdownEditor の呼び出し箇所が増え、モバイル初期タブを呼び出し側から制御したいユースケースが発生した場合

#### C-001: デスクトップ側の initialViewMode 非指定について (nice_to_have)

- **対応**: 実装時にデスクトップ Modal の MarkdownEditor 呼び出し箇所にコメントを追加し、initialViewMode を意図的に省略していることを明記する

#### C-002: filePath 変更時の mobileTab 非リセット (nice_to_have)

- **対応**: 既に設計方針書のセクション 3 トレードオフ表に記載済み。UAT で実機検証する

#### C-003: getInitialViewMode の拡張性 (nice_to_have)

- **対応**: YAGNI に従い現時点では対応不要。モバイル固有の初期化ロジックが増加した場合に再検討する

### Stage 2: 整合性レビュー (score: 4/5, status: approved_with_findings)

#### SF-001 (MF-001): FilePanelContent の initialViewMode 記述が不完全

- **指摘内容**: 「変更しないファイル」テーブルで FilePanelContent.tsx の説明が「既に initialViewMode='preview' を渡している」となっていたが、実際には MarpRenderableMarkdown 内で initialViewMode='split'(line 405)、MarkdownWithSearch 内で initialViewMode='preview'(line 478) の 2 箇所がある。
- **対応**: セクション 2 の「変更しないファイル」テーブルを修正し、両方の呼び出しパスを正確に記述した。

#### SF-002 (MF-002): テストモック戦略に MOBILE_BREAKPOINT エクスポートが不足

- **指摘内容**: セクション 8 の useIsMobile モックに MOBILE_BREAKPOINT エクスポートが含まれていない。既存テスト（WorktreeDetailRefactored.test.tsx, issue-266-acceptance.test.tsx 等）では MOBILE_BREAKPOINT: 768 を併せてエクスポートするパターンが確立されている。
- **対応**: セクション 8 のモック戦略コードサンプルに MOBILE_BREAKPOINT: 768 を追加し、プロジェクト既存パターンとの一貫性を確保した。

#### MF-004: Desktop Modal パスがコンポーネント関係図に不足 (nice_to_have)

- **指摘内容**: セクション 2 のコンポーネント関係図に Desktop Modal 経由（WorktreeDetailRefactored.tsx line 1597）の MarkdownEditor 呼び出しパスが含まれていなかった。
- **対応**: コンポーネント関係図を拡張し、Desktop FilePanelContent 内の 2 つの呼び出しパスおよび Desktop Modal パスを追記した。注記コメントも追加。

### テスト戦略の補足 (レビュー指摘反映)

レビューで指摘されたテストギャップについて：

| ギャップ | 対応方針 |
|---------|---------|
| useEffect タイミングによるフラッシュのテスト | セクション 7 に記載の通り体感影響なし。実機 UAT で確認する。自動テストは費用対効果が低いため見送り |
| Modal + MarkdownEditor の結合テスト（モバイル viewport） | E2E テスト（Playwright）で viewport 設定を含むモバイルシナリオとして実施を検討。ユニットテスト段階では各コンポーネント単体テストでカバーする |

### Stage 3: 影響分析レビュー (score: 4/5, status: approved_with_findings)

#### SF-001: isMobilePortrait がリサイズ/回転に対して非リアクティブ

- **指摘内容**: MarkdownEditor.tsx line 210 の `isMobilePortrait` は `isMobile && window.innerHeight > window.innerWidth` で計算される派生値であり、resize イベントリスナーに紐づいていない。`useIsMobile` hook は resize イベントで `isMobile` を更新するが、同じ viewport 幅のまま端末を回転させた場合（iPad 等、768px 境界付近）や高さだけ変えた場合は `isMobile` が変わらず `isMobilePortrait` が更新されない。portrait -> landscape 切替時に `mobileTab` が `'preview'` のまま残存する。
- **設計判断**: **現行動作を許容（無害な残存状態）**
- **根拠**:
  1. portrait -> landscape 切替時、`showMobileTabs` は `false` となるため `mobileTab` の値は表示に一切影響しない（無害な残存状態）
  2. `isMobilePortrait` の非リアクティブ性は今回の変更で導入されたものではなく、既存の制限である
  3. `mobileTab='preview'` が残存した状態で再度 portrait に戻った場合も、ユーザーが以前選択した `'preview'` がそのまま維持されるため体験上の問題はない
- **将来の改善可能性**: `isMobilePortrait` を resize イベントリスナーに紐づけてリアクティブにするリファクタリングは、タブレット対応を本格化する際に検討する

#### SF-002: 既存テストファイル MarkdownEditor.test.tsx が useIsMobile をモックしていない

- **指摘内容**: `tests/unit/components/MarkdownEditor.test.tsx` は `useIsMobile` hook をモックしておらず、jsdom 環境では `window.innerWidth` が 0 のため `useIsMobile` は常に `false` を返す。新規モバイルテストケースを追加する際に既存テストファイルへのモック追加が必要になるが、グローバルにモックを適用すると既存テストに副作用を及ぼす可能性がある。
- **設計判断**: **describe ブロック内でスコープ付きモックを使用する**
- **根拠**:
  1. 既存のデスクトップテストケースは `useIsMobile` 未モック（= `false`）の前提で動作しており、グローバルモック追加は既存テストの前提を崩す可能性がある
  2. `describe('mobile specific', () => { ... })` ブロック内で `vi.mock` を設定し、モバイル固有テストのスコープを限定する
  3. モバイル固有テストが増加し describe ブロックが肥大化した場合は、`MarkdownEditor.mobile.test.tsx` のような別ファイル分離を検討する
- **テストコード構造**:
  ```typescript
  // 既存テストケース（useIsMobile 未モック = デスクトップ前提）
  describe('MarkdownEditor', () => {
    // ... 既存テスト（変更なし）
  });

  // モバイル固有テスト（スコープ付きモック）
  describe('MarkdownEditor - mobile', () => {
    beforeEach(() => {
      vi.mocked(useIsMobile).mockReturnValue(true);
    });
    afterEach(() => {
      vi.mocked(useIsMobile).mockReturnValue(false);
    });
    // ... モバイル固有テストケース
  });
  ```

#### SF-003: Desktop Modal パスの DevTools エミュレーション時のエッジケース

- **指摘内容**: WorktreeDetailRefactored.tsx line 1597 の Desktop Modal パスの MarkdownEditor は `initialViewMode` を指定しておらず、localStorage の値または `'split'` がデフォルトになる。DevTools でモバイルエミュレーションを使った場合、Desktop Modal パスから MarkdownEditor が開かれつつ `isMobile=true` となるケースが理論上ありうる。この場合 localStorage に `'editor'` があると `showMobileTabs=false` となり、`useEffect` で `mobileTab='preview'` が設定されても MobileTabBar が表示されない。
- **設計判断**: **対応不要（開発者向けエッジケース）**
- **根拠**:
  1. Desktop Modal パスは `isMobile=false` が前提であり、DevTools エミュレーション等で `isMobile=true` になるのは開発者がデバッグ目的で行う操作に限定される
  2. エンドユーザーが遭遇するシナリオではない
  3. C-001 の対応（デスクトップ Modal の MarkdownEditor 呼び出しにコメント追加）と併せて、`initialViewMode` を意図的に省略している理由を明記することで開発者の混乱を防止する

#### NH-001: filePath 変更時の isLoading 状態と mobileTab の関係

- **指摘内容**: `filePath` は依存配列に含めない判断自体は妥当だが、`filePath` 変更時に `loadContent` が再実行され `isLoading=true->false` の遷移が発生する間に `mobileTab` の値がどうなるかのフローが明示されていない。
- **対応**: セクション 9 の注意点に補足を追記済み（下記参照）。`isLoading=true` の間はローディング表示が優先されるため、`mobileTab` の値に関わらず editor/preview コンテンツは表示されない。`filePath` を依存配列から除外しても安全であることが裏付けられる。

#### NH-002: useSwipeGesture / useVirtualKeyboard との相互作用

- **指摘内容**: MarkdownEditor.tsx で使用される `useSwipeGesture`（最大化モード時の下スワイプ解除）と `useVirtualKeyboard`（キーボード表示時の padding 調整）が今回の変更と独立であることが設計方針書に記載されていない。
- **対応**: 以下の通り確認的に記載する。
  - `useSwipeGesture`: 最大化モードの下スワイプ解除を担当。`mobileTab` state とは独立しており、今回の変更の影響を受けない
  - `useVirtualKeyboard`: 仮想キーボード表示時の padding 調整を担当。`mobileTab` state とは独立しており、今回の変更の影響を受けない
  - これらのフックは MarkdownEditor のモバイル UX に関与するが、mobileTab の初期値変更とは直交する機能である

### 実装チェックリスト (レビュー反映済み)

- [ ] MarkdownEditor.tsx: mobileTab 初期化 useEffect を追加（Stage 1 SF-001 判断: インライン維持）
- [ ] WorktreeDetailRefactored.tsx: モバイル Modal の MarkdownEditor に `initialViewMode="split"` を追加
- [ ] WorktreeDetailRefactored.tsx: デスクトップ Modal の MarkdownEditor 呼び出しにコメント追加（Stage 1 C-001, Stage 3 SF-003 対応）
- [ ] ユニットテスト: セクション 8 の 5 テストケースを実装（Stage 3 SF-002: describe ブロック内スコープ付きモック使用）
- [ ] 実機 UAT: モバイルでのフラッシュ有無を確認（Stage 1 C-002, セクション 7）
- [ ] 実機 UAT: portrait -> landscape 切替時の動作確認（Stage 3 SF-001: mobileTab 残存が無害であること）

## 11. スコープ外

- MARPフロントマターを持つMarkdownファイル（既存のスライド表示フローを維持）
- PC（デスクトップ）版の動作変更
- タブレットランドスケープモード（`isMobilePortrait`が`false`のためデスクトップレイアウト適用）。なお `isMobilePortrait` は resize イベントリスナーに紐づいていない派生値であり、portrait -> landscape 切替時に `mobileTab='preview'` が残存するが、`showMobileTabs=false` となるため表示に影響しない（Stage 3 SF-001）。将来 `isMobilePortrait` をリアクティブにするリファクタリングはタブレット対応本格化時に検討する
- FileViewer内のMarkdown raw表示（MarkdownEditorとは別フロー）
