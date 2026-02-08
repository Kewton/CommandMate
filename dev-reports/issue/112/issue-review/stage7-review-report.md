# Issue #112 Stage 7 レビューレポート

**レビュー日**: 2026-02-01
**ステージ**: 影響範囲レビュー（2回目）
**対象Issue**: perf: サイドバートグルのパフォーマンス改善（transform方式への変更）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |

Stage 3の指摘事項は概ね適切に反映されており、実装可能な状態に達している。

---

## 前回指摘事項の対応状況

### MUST-FIX（必須対応）: 全3件対応済み

| ID | 指摘内容 | 状況 |
|----|---------|------|
| MUST-001 | AppShell.test.tsxのテストケース更新 | **対応済み** - 具体的な変更箇所（L281, L302）と変更内容が明記 |
| MUST-002 | SidebarToggle.tsxの位置計算確認 | **対応済み** - 確認必要として明記、代替案も言及 |
| MUST-003 | z-index階層管理との整合性確認 | **対応済み** - SIDEBAR(30)追加、競合確認が明記 |

### SHOULD-FIX（推奨対応）: 全4件対応済み

| ID | 指摘内容 | 状況 |
|----|---------|------|
| SHOULD-001 | レイアウト方式の選択 | **対応済み** - オーバーレイ型/プッシュ型の説明追加 |
| SHOULD-002 | CSSトランジション最適化 | **対応済み** - transition-transform変更が明記 |
| SHOULD-003 | モバイル互換性確認 | **対応済み** - 768px判定ポイントの確認が明記 |
| SHOULD-004 | アクセシビリティ | **対応済み** - aria-hidden連動の検討が明記 |

### NICE-TO-HAVE（あれば良い）: 1件対応済み、1件部分対応、1件未対応

| ID | 指摘内容 | 状況 |
|----|---------|------|
| NICE-001 | will-change-transform追加 | 未対応（必須ではない） |
| NICE-002 | SidebarContext width機能コメント | **対応済み** |
| NICE-003 | 内部ラッパー削除 | **部分対応** - 実装イメージには反映、対象ファイル一覧には未明記 |

---

## 新規指摘事項

### Should Fix（推奨対応）

#### SF-NEW-001: z-index競合詳細の明確化

**カテゴリ**: z-index階層管理
**場所**: z-index階層管理セクション

**問題**:
WorktreeDetailRefactored.tsxのz-30使用箇所（L1552: AutoYesToggle、L1588: MessageInput）を確認したところ、これらはモバイルレイアウト専用の要素である。デスクトップサイドバーのz-30とは`isMobile`判定により同時に表示されることはなく、直接的な競合は発生しない。

ただし、z-index.tsにSIDEBAR(30)を追加する際、開発者が混乱しないよう、この点をコメントで明記することを推奨する。

**推奨対応**:
z-index.tsにSIDEBAR(30)追加時、以下のコメントを追加:
```typescript
/** Desktop sidebar - not used on mobile where MobileHeader(z-40) and drawer(z-50) are used */
SIDEBAR: 30,
```

---

#### SF-NEW-002: SidebarToggle位置調整の具体策

**カテゴリ**: 実装方針の明確化
**場所**: 確認・調整必要 セクション

**問題**:
SidebarToggle.tsxの`left-[284px]`（サイドバー幅288px - 4px）は、現在のwidth方式ではサイドバー右端に配置される。しかし、transform方式（オーバーレイ型）ではサイドバーがfixed配置となるため、レイアウト構造が変わる。

現在は「確認」のみの記載だが、具体的な調整方針が不明確。

**推奨対応**:
以下のいずれかの方針を明記:
1. SidebarToggleをサイドバー内部に移動（最も単純）
2. SidebarToggleもfixed配置に変更し`left-[284px]`を維持
3. SidebarToggleの位置をサイドバーのtransform状態に連動

---

### Nice to Have（あれば良い）

#### NTH-NEW-001: E2Eテスト範囲の明確化

**場所**: 確認・調整必要 セクション

tests/e2e/worktree-detail.spec.tsを確認したところ、サイドバー表示/非表示の切り替えに関する直接的なテストは存在しない。

**推奨対応**:
「サイドバー関連のE2Eテストが存在しないため、影響は軽微と想定。ただし、レスポンシブテスト（L172-186のモバイルビューポートテスト）でサイドバー動作に影響がないか確認」と具体化。

---

#### NTH-NEW-002: SidebarToggle.test.tsx影響確認の明確化

**場所**: 確認・調整必要 セクション

SidebarToggle.test.tsxを確認したところ、位置（left-[284px]/left-2）に関する直接的なテストは存在しない。

**推奨対応**:
「位置関連のテストは存在しないため更新不要。ただし、transform方式でSidebarToggleの配置方式を変更する場合は、新規テストの追加を検討」と明記。

---

## 影響ファイル検証結果

| ファイル | 検証結果 | 備考 |
|---------|---------|------|
| src/components/layout/AppShell.tsx | **確認済み** | デスクトップレイアウト（L85-116）がwidth方式を使用 |
| tests/unit/components/layout/AppShell.test.tsx | **確認済み** | L281の`w-72`、L302の`w-0`チェックの更新が必要 |
| src/config/z-index.ts | **確認済み** | SIDEBAR定数が存在しない。追加必須 |
| src/components/layout/SidebarToggle.tsx | **確認済み** | L42の`left-[284px]`/`left-2`の動作確認必要 |
| tests/unit/components/layout/SidebarToggle.test.tsx | **確認済み** | 位置関連テストなし。変更不要の可能性高 |
| tests/e2e/worktree-detail.spec.ts | **確認済み** | サイドバー切り替えテストなし。影響軽微 |
| src/components/worktree/WorktreeDetailRefactored.tsx | **確認済み** | z-30はモバイル専用。競合なし |

---

## 総合評価

Issue #112は、Stage 3の影響範囲レビュー指摘事項を適切に反映し、実装に進むことが可能な状態にある。

**主な改善点**:
- テスト更新箇所が具体的に特定されている（L281, L302）
- z-index階層管理方針が明確化されている
- レイアウト方式の選択肢（オーバーレイ型/プッシュ型）が提示されている
- モバイル互換性、アクセシビリティの考慮が追加されている

**残課題**:
- SidebarToggleの位置調整の具体策を明記することを推奨（Should Fix）
- z-30競合に関するコメント追記を推奨（Should Fix）

これらのShould Fix項目は、実装フェーズで対応可能な範囲であり、Issue自体は承認可能な品質に達している。
