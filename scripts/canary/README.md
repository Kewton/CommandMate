# scripts/canary — 検出カナリア

実 `claude` の TUI を使い捨て tmux セッションで起動し、capture したフレームを本番と同じ検出関数
（`detectSessionStatus` / `detectPrompt`）に食わせて期待値を assert する（Issue #1727）。

Issue #1847 で **Auto-Yes v2（`PermissionRequest` hook による裁定）の 2 シナリオ**が加わった。
この 2 本は本番の設定生成器が書いた `--settings` ファイルをカナリア自身の受け口
（ephemeral な loopback ポート）に向け、`allow` でダイアログが出ないこと／no-decision で
ダイアログが出て `autoYes.lastSuppression` に理由が載ることを、pane と構造化レイヤの両方で見る。

```bash
npm run canary                   # 7 シナリオ
npm run canary -- --list         # シナリオ一覧
npm run canary -- --help         # オプション
npm run canary -- --mutate       # 自己テスト: 誤った期待値で全部赤になること
npm run canary -- --mutate-verdict  # 自己テスト: 受け口が逆の裁定を返すと hook シナリオが赤になること
```

> **permission mode**: 全セッションを `--permission-mode manual` で起動する。
> Claude Code 2.1.236 で既定が auto mode になり、auto mode では承認ダイアログ自体が描画されない
> （`CANARY_PERMISSION_MODE` / `session.ts` のコメント参照）。

**手順・費用・隔離の仕組み・CI 組み込み案は [docs/qa/detection-canary.md](../../docs/qa/detection-canary.md) を参照。**

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.ts` | エントリポイント（ログレベルを固定してから runner を動的 import） |
| `runner.ts` | 実行フロー: preflight → ガード取得 → 使い捨て HOME → 私設 tmux → シナリオ実行 → 後始末 → 再検証 |
| `scenarios.ts` | シナリオの定義（**追加はここに 1 エントリ足すだけ**） |
| `expectations.ts` | 期待値・起動オーバーレイ・上流障害パターン（すべて**純関数**。単体テスト対象） |
| `hook-expectations.ts` | Auto-Yes v2 シナリオの期待値（フレームではなく `Observation.hooks` を読む。#1847） |
| `hook-receiver.ts` | `PermissionRequest` / agent-event の受け口。裁定は本体の `resolvePermissionRequest`（#1847） |
| `probe.ts` | フレーム → 検出 2 経路の verdict（本番の呼び方を複製） |
| `session.ts` | 使い捨て claude セッション（起動・オーバーレイ処理・送信・ポーリング） |
| `tmux-private.ts` | `-L cmate-canary-*` を強制する tmux ラッパ（`kill-server` はここ経由でしか到達できない） |
| `isolated-home.ts` | 使い捨て HOME の作成・シード・認証解決・破棄 |
| `guards.ts` | 実 `~/.claude/settings.json` と `mcbd-*` セッションの before/after 検証 |
| `fixtures.ts` | `tests/fixtures/canary/` への実フレーム保存（`.ts` モジュール ＋ 生 `.raw.txt`） |
| `cli.ts` | 引数パース・ヘルプ |

純関数部分の単体テストは `tests/unit/canary/`（tmux も課金も不要、CI で回る）。
