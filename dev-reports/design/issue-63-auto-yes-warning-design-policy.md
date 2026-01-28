# Issue #63: Auto Yesモード警告ダイアログ - 設計方針書

## 1. 概要

auto yesモードをONにする際に確認ダイアログを表示し、リスク説明と免責事項への同意を得てからモードを有効化する。OFFにする操作ではダイアログを表示しない。

## 2. システム構成

```
┌────────────────────────────────────────────────────┐
│  AutoYesToggle (既存・変更あり)                     │
│    ├── ON操作 → ダイアログ表示                      │
│    │     └── AutoYesConfirmDialog (新規)            │
│    │           ├── 同意 → onToggle(true) 呼び出し   │
│    │           └── キャンセル → 何もしない           │
│    └── OFF操作 → onToggle(false) 直接呼び出し       │
└────────────────────────────────────────────────────┘

※ WorktreeDetailRefactored、API、サーバー側ロジックは変更なし
```

## 3. 設計判断

### 3.1 ダイアログ状態の管理場所

| 方式 | メリット | デメリット |
|------|---------|-----------|
| **AutoYesToggle内部 (採用)** | 影響範囲最小、親コンポーネント変更不要 | コンポーネントの責務が若干増える |
| WorktreeDetailRefactored側 | 親が全状態を把握 | handleAutoYesToggle変更必要、影響範囲拡大 |

**理由**: ダイアログは「ONにする前の確認」という`AutoYesToggle`のUI内部の関心事であり、親コンポーネントからは「onToggle(true)が呼ばれた＝同意済み」として扱えばよい。

### 3.2 ダイアログコンポーネントの実装方式

| 方式 | メリット | デメリット |
|------|---------|-----------|
| **既存Modal利用 (採用)** | UI統一、Escape対応・スクロール制御済み | Modalのsize指定が必要 |
| 独自ダイアログ | 完全にカスタム可能 | 重複実装、UI不統一 |
| window.confirm | 実装が最も簡単 | スタイル制御不可、免責事項の表示に不適 |

**理由**: 既存`Modal`（`src/components/ui/Modal.tsx`）はEscapeキー対応、背景クリック閉じ、bodyスクロール抑制、モバイル対応（`max-w-[calc(100vw-2rem)]`）が実装済み。これを土台にすることで品質を担保しつつ実装コストを最小化できる。

### 3.3 同意の記憶

| 方式 | メリット | デメリット |
|------|---------|-----------|
| **毎回表示 (採用)** | 安全性が高い、実装シンプル | ONにするたびに1クリック増える |
| セッション中1回のみ | 操作が楽 | リスク認識の形骸化 |

**理由**: auto yesモードは1時間タイムアウトで自動OFFになるため、再ON時には改めてリスクを確認させるべき。頻繁にON/OFFする使い方は想定していない。

### 3.4 Backdrop（背景）クリック時の挙動

| 方式 | メリット | デメリット |
|------|---------|-----------|
| **キャンセル扱い (採用)** | 既存Modalの挙動と一貫、誤操作でONにならない | なし |
| 何もしない | 意図的な操作を強制 | 既存Modalの挙動と不一致 |

**理由**: 既存`Modal`の`onClose`が背景クリックに紐づいている。キャンセル＝`onClose`として統一する。

## 4. コンポーネント設計

### 4.1 AutoYesConfirmDialog

```typescript
// src/components/worktree/AutoYesConfirmDialog.tsx

export interface AutoYesConfirmDialogProps {
  isOpen: boolean;
  onConfirm: () => void;  // 同意して有効化
  onCancel: () => void;   // キャンセル
}
```

- 既存`Modal`を`size="sm"`で利用
- `title`: 警告アイコン + 「Auto Yesモードを有効にしますか？」
- `showCloseButton: true`（Xボタン・背景クリック・Escapeすべてをキャンセル動作として統一）
- children内に警告メッセージ・免責事項・ボタンを配置

### 4.2 AutoYesToggle 変更箇所

```typescript
// handleToggle の変更イメージ
const handleToggle = useCallback(async () => {
  if (!enabled) {
    // ON操作 → ダイアログを開く
    setShowConfirmDialog(true);
  } else {
    // OFF操作 → 直接実行
    setToggling(true);
    try {
      await onToggle(false);
    } finally {
      setToggling(false);
    }
  }
}, [enabled, onToggle]);

// ダイアログ同意時
const handleConfirm = useCallback(async () => {
  setShowConfirmDialog(false);
  setToggling(true);
  try {
    await onToggle(true);
  } finally {
    setToggling(false);
  }
}, [onToggle]);
```

追加するstate: `showConfirmDialog: boolean`

## 5. UI構成

### ダイアログレイアウト

```
┌──────────────────────────────────────┐
│  ⚠️ Auto Yesモードを有効にしますか？  │
├──────────────────────────────────────┤
│                                      │
│  CLIツールからの確認プロンプトに       │
│  自動で応答します。                   │
│                                      │
│  • yes/no確認 → 自動で「yes」         │
│  • 選択肢 → デフォルトまたは先頭を選択 │
│                                      │
│  ⚠ ファイル操作・コマンド実行等の      │
│  確認にも自動で許可が出されます。      │
│  1時間後に自動でOFFになります。        │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ 本機能の利用はユーザーの自己    │  │
│  │ 責任となります。自動応答により  │  │
│  │ 実行された操作について、ツール  │  │
│  │ 側は責任を負いません。         │  │
│  └────────────────────────────────┘  │
│                                      │
│  [キャンセル]  [同意して有効化]       │
│                                      │
└──────────────────────────────────────┘
```

### スタイル方針
- 免責事項: `bg-yellow-50 border-l-4 border-yellow-400 p-3`（注意喚起ブロック）
- 「同意して有効化」ボタン: `bg-yellow-600 hover:bg-yellow-700 text-white`（警告色）
- 「キャンセル」ボタン: `bg-gray-200 hover:bg-gray-300 text-gray-700`（副アクション）

## 6. 影響範囲

### 変更ファイル

| ファイル | 変更内容 | 変更量 |
|---------|---------|--------|
| `src/components/worktree/AutoYesToggle.tsx` | ダイアログ状態管理、handleToggle分岐追加 | 小 |
| 新規: `src/components/worktree/AutoYesConfirmDialog.tsx` | 確認ダイアログコンポーネント | 新規 |

### 変更不要

| ファイル | 理由 |
|---------|------|
| `src/components/worktree/WorktreeDetailRefactored.tsx` | handleAutoYesToggleはonToggle経由で呼ばれるだけ |
| `src/components/ui/Modal.tsx` | そのまま利用 |
| `src/hooks/useAutoYes.ts` | 同意後のフローは既存と同一 |
| `src/lib/auto-yes-manager.ts` | サーバー側変更なし |
| `src/lib/auto-yes-resolver.ts` | 応答ロジック変更なし |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | API変更なし |

## 7. テスト方針

| テスト種別 | 対象 | 内容 |
|-----------|------|------|
| Unit | AutoYesConfirmDialog | ダイアログ表示、同意・キャンセルコールバック |
| Unit | AutoYesToggle | ON操作でダイアログ表示、OFF操作で直接実行 |
| E2E | ワークツリー詳細画面 | トグルON→ダイアログ表示→同意→モード有効化の一連フロー |

## 8. 設計上のトレードオフ

| 決定事項 | 採用理由 | トレードオフ |
|---------|---------|-------------|
| ダイアログ状態をAutoYesToggle内部管理 | 影響範囲最小化 | トグルコンポーネントの責務がやや増加 |
| 既存Modal利用 | UI統一・実装コスト削減 | Modal のAPIに依存 |
| 毎回ダイアログ表示 | 安全性優先 | 操作ステップが1つ増加 |
| 免責文言はPRで確定 | Issue変更を減らす | 設計書時点では文言未確定 |
