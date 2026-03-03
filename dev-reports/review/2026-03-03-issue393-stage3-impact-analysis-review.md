# Issue #393 Stage 3: 影響分析レビュー

## 概要

| 項目 | 内容 |
|------|------|
| **Issue** | #393 - security: authenticated RCE and shell injection via /api/worktrees/[id]/terminal |
| **ステージ** | Stage 3 - 影響分析レビュー |
| **フォーカス** | 影響範囲 |
| **レビュー日** | 2026-03-03 |
| **結果** | 条件付き承認 |
| **スコア** | 4/5 |

## Executive Summary

設計方針書の修正計画が実施された場合の波及効果を分析した。tmux.ts の exec→execFile 移行は公開インターフェースを変更しないため、直接インポートしている14ファイルのうち12ファイルへの波及は無い。主要なリスクは (1) テストファイルのモック更新、(2) terminal/route.ts の sendToTmux() 廃止と sendMessage() 代替における意味的差異、(3) execFile での maxBuffer 互換性、(4) エラーオブジェクト形状の差異確認の4点に集中する。破壊的変更のリスクは低い。

---

## 1. tmux.ts の exec→execFile 移行の波及

### 1.1 tmux.ts をインポートする全14ファイル

| # | ファイル | インポート内容 | 影響 |
|---|---------|---------------|------|
| 1 | `src/lib/cli-session.ts` | hasSession, capturePane | なし（公開I/F不変） |
| 2 | `src/lib/pasted-text-helper.ts` | capturePane, sendKeys | なし（公開I/F不変） |
| 3 | `src/lib/prompt-answer-sender.ts` | sendKeys, sendSpecialKeys | なし（公開I/F不変） |
| 4 | `src/lib/claude-session.ts` | hasSession, createSession, sendKeys, capturePane, killSession | **line 783 のみ修正** |
| 5 | `src/lib/cli-tools/codex.ts` | hasSession, createSession, sendKeys, killSession | **4箇所の exec() 修正** |
| 6 | `src/lib/cli-tools/gemini.ts` | hasSession, createSession, sendKeys, sendSpecialKey, killSession, capturePane | なし（公開I/F不変） |
| 7 | `src/lib/cli-tools/vibe-local.ts` | hasSession, createSession, sendKeys, sendSpecialKey, killSession | なし（公開I/F不変） |
| 8 | `src/lib/cli-tools/opencode.ts` | hasSession, createSession, sendKeys, sendSpecialKey, killSession | なし（既にexecFile使用） |
| 9 | `src/lib/cli-tools/base.ts` | sendSpecialKey | なし（公開I/F不変） |
| 10 | `src/app/api/repositories/route.ts` | killSession | なし（公開I/F不変） |
| 11 | `src/app/api/worktrees/[id]/respond/route.ts` | sendKeys | なし（公開I/F不変） |
| 12 | `src/app/api/worktrees/[id]/kill-session/route.ts` | killSession | なし（公開I/F不変） |
| 13 | `src/app/api/worktrees/[id]/terminal/route.ts` | import * as tmux | **D1でエンドポイント修正** |
| 14 | `src/app/api/worktrees/[id]/capture/route.ts` | import * as tmux | **D1でエンドポイント修正** |

**結論**: 14ファイル中10ファイルは影響なし。直接修正対象は4ファイル（#4, #5, #13, #14）。

### 1.2 エラーオブジェクト形状の変化

`exec()` は `ExecException` 型、`execFile()` は `ExecFileException` 型のエラーを返す。tmux.ts の各関数はエラーを `error instanceof Error ? error.message : String(error)` で処理しているため、基本的に問題なし。

**注意点**: `killSession()` の `errorMessage.includes('no server running')` / `errorMessage.includes("can't find session")` パターンマッチは tmux プロセスの stderr に基づくため、exec/execFile 間で差異はない。ただし、tmux 自体が未インストールの場合のエラーメッセージ形式は確認が必要（R3F010）。

### 1.3 sendKeys() エスケープロジック除去

| 項目 | exec() 時代 | execFile() 移行後 |
|------|------------|-------------------|
| シングルクォートエスケープ | `keys.replace(/'/g, "'\\''")` でシェル保護 | 不要（シェル非経由） |
| tmux への入力 | シェルがクォートを解除してから tmux に渡す | 直接引数として tmux に渡す |
| 最終的な tmux 入力 | 同一 | 同一 |

動作変更なし。テスト `'should escape single quotes'`（tmux.test.ts line 224-237）は更新が必要。

### 1.4 maxBuffer 互換性

`capturePane()` は `maxBuffer: 10 * 1024 * 1024`（10MB）を指定。Node.js の `execFile()` も `maxBuffer` をサポートしているため技術的には問題ない。ただし、移行時の見落とし防止のため実装時に手動確認が望ましい（R3F008）。

---

## 2. terminal/route.ts / capture/route.ts の修正波及

### 2.1 sendToTmux() 廃止の波及

**現在の構造**:
```
terminal/route.ts POST
  -> sendToTmux(sessionName, command)
    -> tmux.sendKeys(sessionName, command)  // sendEnter=true (default)
```

**設計方針書の修正後**:
```
terminal/route.ts POST
  -> CLIToolManager.getInstance().getTool(cliToolId).sendMessage(worktreeId, command)
```

**意味的差異（R3F003）**:

| 操作 | sendToTmux() (現在) | sendMessage() (各ツール) |
|------|---------------------|-------------------------|
| テキスト送信 | sendKeys(session, command, true) | sendKeys(session, message, false) |
| Enter 送信 | sendKeys の default=true で同時 | 別途 100ms 待機後に C-m 送信 |
| 追加待機 | なし | 200ms + Pasted text 検知 |
| 合計遅延 | ~0ms | ~300ms以上 |

terminal エンドポイントは「任意のコマンド送信」用途であり、sendMessage() の「プロンプト応答」セマンティクスとは異なる。設計方針書の D1-004 でこの差異を考慮した具体的な代替案が必要。

### 2.2 CLIToolManager 経由への切り替えで追加される依存関係

| 修正前の依存 | 修正後の依存 |
|-------------|-------------|
| `import * as tmux from '@/lib/tmux'` | `import { CLIToolManager } from '@/lib/cli-tools/manager'` |
| `import type { CLIToolType } from '@/lib/cli-tools/types'` | `import { isCliToolType, CLI_TOOL_IDS } from '@/lib/cli-tools/types'` |
| - | `import { getWorktreeById } from '@/lib/db'` |
| - | `import { getDbInstance } from '@/lib/db-instance'` |

依存関係の方向が「低レベル tmux モジュール」から「高レベル CLIToolManager インターフェース」に変更され、DIP に準拠する。新規インポートは既存パターン（respond/route.ts, kill-session/route.ts）と同一。

### 2.3 セッション自動作成廃止による動作変更

| エンドポイント | 現在の動作 | 修正後の動作 |
|-------------|-----------|-------------|
| terminal POST | セッション不在時: createSession() + コマンド送信 | セッション不在時: 404 |
| capture POST | セッション不在時: 200 + "Starting..." メッセージ | セッション不在時: 404（要設計判断） |

フロントエンドコードで terminal/capture の REST API を直接呼ぶ箇所は見つからなかった（Terminal.tsx は WebSocket 使用）。外部連携が存在する場合のみ破壊的変更となる。

---

## 3. codex.ts の exec→tmux関数統一の波及

### 3.1 各箇所の動作変更分析

| 行 | 変更前 | 変更後 | 動作変更リスク |
|----|-------|--------|--------------|
| 102 | `execAsync(\`tmux send-keys -t "${sessionName}" Down\`)` | `tmux.sendSpecialKeys(sessionName, ['Down'])` | **なし** - 単一要素配列で SPECIAL_KEY_DELAY_MS 不発動 |
| 104 | `execAsync(\`tmux send-keys -t "${sessionName}" Enter\`)` | `tmux.sendSpecialKeys(sessionName, ['Enter'])` | **なし** - 単一要素配列で SPECIAL_KEY_DELAY_MS 不発動 |
| 139 | `execAsync(\`tmux send-keys -t "${sessionName}" C-m\`)` | `tmux.sendSpecialKey(sessionName, 'C-m')` | **なし** - 直接 execFile 実行 |
| 170 | `execAsync(\`tmux send-keys -t "${sessionName}" C-d\`)` | `tmux.sendSpecialKey(sessionName, 'C-d')` | **なし** - 直接 execFile 実行 |

**SPECIAL_KEY_DELAY_MS 分析**: `sendSpecialKeys()` は keys 配列の各要素間に 100ms ディレイを挿入するが、ループの最終要素ではスキップする（`if (i < keys.length - 1)`）。単一要素配列 `['Down']` や `['Enter']` の場合、ループは1回のみ実行され、ディレイは発動しない。

### 3.2 claude-session.ts line 783 の変更

```typescript
// Before
await execAsync(`tmux send-keys -t "${sessionName}" C-d`);

// After
await sendSpecialKey(sessionName, 'C-d');
```

`sendSpecialKey` は D2-005 でランタイムバリデーション（ALLOWED_SINGLE_SPECIAL_KEYS）が追加される予定。'C-d' はこのセットに含まれるため問題なし。

### 3.3 インポート変更

```typescript
// Before
import { hasSession, createSession, sendKeys, killSession } from '../tmux';
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

// After
import { hasSession, createSession, sendKeys, killSession, sendSpecialKeys, sendSpecialKey } from '../tmux';
// exec/execAsync 削除
```

codex.ts 内で exec() の他の使用箇所がないことを確認済み（全4箇所が全て tmux send-keys 用途）。

---

## 4. テスト変更の影響

### 4.1 tmux.test.ts モック変更の波及範囲

| テストファイル | child_process モック方法 | tmux.test.ts 変更の影響 |
|-------------|----------------------|----------------------|
| tmux.test.ts | `vi.mock('child_process', () => ({ exec: vi.fn() }))` | **直接影響** - execFile に変更 |
| claude-session.test.ts | `vi.mock('child_process', ...)` + `vi.mock('@/lib/tmux', ...)` | なし - tmux をモジュールモック |
| codex.test.ts | モックなし（プロパティテストのみ） | なし |
| base.test.ts | tmux モジュールモック（推定） | なし |

Vitest のモジュールモックはファイルスコープで独立しているため、tmux.test.ts のモック変更は他ファイルに波及しない。

### 4.2 必要なテスト更新

| 対象 | 更新内容 | 影響度 |
|------|---------|--------|
| tmux.test.ts 全テスト | `exec` → `execFile` モック、アサーション更新（文字列→配列） | **高** - 約20箇所 |
| tmux.test.ts `sendKeys` | エスケープテスト更新（エスケープ不要化） | **中** |
| claude-session.test.ts | tmux モックに `sendSpecialKey` 追加 | **中** |
| 新規 terminal-route.test.ts | 5テストケース追加 | 新規 |
| 新規 capture-route.test.ts | 4テストケース追加 | 新規 |

### 4.3 テスト実行時間への影響

現在約100ファイルの unit テスト。新規2ファイル追加（約2%増加）。モックベースのため各ファイルの実行時間は数百ms。全体への影響は1秒未満で無視できる。

---

## 5. 後方互換性

### 5.1 公開インターフェース変更

| エンドポイント/モジュール | 変更内容 | 破壊的変更 |
|--------------------------|---------|-----------|
| tmux.ts 全公開関数 | 内部実装 exec→execFile | **なし** - シグネチャ不変 |
| terminal POST | バリデーション追加 (400/404) | **軽微** - 以前は無効入力でも処理 |
| terminal POST | セッション自動作成廃止 | **あり** - 以前は自動作成していた |
| capture POST | バリデーション追加 (400/404) | **軽微** - 以前は無効入力でも処理 |

### 5.2 外部連携への影響

フロントエンドコードで terminal/capture の REST API を直接呼ぶ箇所は確認されなかった:
- `Terminal.tsx` は WebSocket (`ws://localhost:3000/terminal/...`) を使用
- 他のコンポーネント/フックからの REST API 呼び出しは `captureSessionOutput()` (cli-session.ts) 経由

外部ツールが直接 terminal/capture API を呼んでいる場合のみ影響がある。

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| テスト互換性 | tmux.test.ts の全面モック更新 | Medium | High | P1 |
| 意味的差異 | sendToTmux→sendMessage の遅延追加 | Medium | Medium | P1 |
| maxBuffer互換性 | capturePane 10MB バッファ | Low | Low | P2 |
| エラー形状差異 | exec→execFile のエラーメッセージ | Low | Low | P2 |
| 後方互換性 | セッション自動作成廃止 | Low | Low | P3 |

---

## 指摘事項サマリー

### Must Fix（2件）

| ID | カテゴリ | タイトル |
|----|---------|---------|
| R3F002 | 波及影響 | claude-session.test.ts の tmux モックに sendSpecialKey 追加が必要 |
| R3F008 | 波及影響 | capturePane() の maxBuffer=10MB が execFile() でも機能することの確認 |

### Should Fix（5件）

| ID | カテゴリ | タイトル |
|----|---------|---------|
| R3F001 | 動作変更リスク | codex.ts の sendSpecialKeys 移行で SPECIAL_KEY_DELAY_MS が不発動であることの設計補足 |
| R3F003 | 波及影響 | sendToTmux() 廃止と sendMessage() 代替の意味的差異 |
| R3F004 | 後方互換性 | セッション自動作成廃止の capture/route.ts への統一方針 |
| R3F007 | 波及影響 | sendKeys() エスケープロジック除去に伴うテスト更新方針の明記 |
| R3F010 | 動作変更リスク | exec/execFile のエラーオブジェクト形状差異の確認 |

### Nice to Have（4件）

| ID | カテゴリ | タイトル |
|----|---------|---------|
| R3F005 | テスト影響 | tmux.test.ts のモック変更は他テストに波及しない（確認済み） |
| R3F006 | テスト影響 | 新規テスト追加のテスト実行時間への影響は軽微 |
| R3F009 | 波及影響 | 間接影響ファイルリストに4ファイル追記推奨 |
| R3F011 | 後方互換性 | 公開インターフェース形式は変更されない（確認済み） |

---

## 結論

設計方針書の修正計画は波及影響を適切に管理できている。公開インターフェース不変の方針（SEC-003）により、tmux.ts の14の直接インポート元のうち10ファイルへの影響がゼロに抑えられている。

主要な注意点は:
1. **terminal/route.ts の sendMessage() 代替**での遅延追加（R3F003）- 設計補足が必要
2. **テストファイルの更新範囲**の具体化（R3F002, R3F007）- claude-session.test.ts のモック追加とエスケープテスト更新
3. **execFile 互換性**の実装時確認（R3F008, R3F010）- maxBuffer とエラーメッセージ形式

上記の補足を設計方針書に追記すれば、安全に実装を進められる。

---

*Generated by architecture-review-agent for Issue #393 Stage 3*
*Reviewed: 2026-03-03*
