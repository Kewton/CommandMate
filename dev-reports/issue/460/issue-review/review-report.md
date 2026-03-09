# Issue #460 レビュー

対象: `feat: introduce tmux control mode transport for live terminal interaction`

## 総評

方向性は妥当です。特に `capture-pane` + ポーリング + キャッシュの積み上げでライブ性とTUI互換性が劣化している、という問題設定は現行コードと整合しています。

ただし、元の issue は「どこまで control mode に置き換えるのか」「既存の HTTP/WebSocket/DB/poller 経路に何を残すのか」「導入時のセキュリティ境界をどう守るか」が不足しており、このままだと実装時にスコープ膨張しやすい状態でした。

## 根拠確認

### 性能

- `src/lib/response-poller.ts` は 2 秒ポーリングを前提にしており、`capture-pane` 前提の抽出・補償ロジックを持っています。
- `src/lib/cli-session.ts` と `src/lib/tmux-capture-cache.ts` は `capture-pane` 呼び出しの削減を行っていますが、これはライブ性向上ではなく重複呼び出し抑制です。
- `src/app/api/worktrees/[id]/current-output/route.ts` も 10,000 行スナップショット取得に依存しているため、terminal page だけ control mode 化しても main worktree detail のポーリング負荷は残ります。

### 拡張性

- `src/lib/tmux.ts` は session lifecycle、input、snapshot capture、kill を単一モジュールで提供しており、transport seam を切る価値があります。
- `src/lib/response-poller.ts` には OpenCode 向け TUI accumulator が存在し、transport 非依存のはずの上位ロジックにツール固有補償が漏れています。
- `src/lib/cli-tools/opencode.ts` には `resize-window` ベースの補償があり、terminal fidelity の不足が CLI ごとの分岐に波及しています。

### セキュリティ

- `src/app/api/worktrees/[id]/terminal/route.ts` は入力長制限、worktree existence check、session existence check を持っていますが、issue 原文は control mode 導入後の server-side authorization と subscription lifecycle を定義していません。
- `src/lib/ws-server.ts` には auth / IP restriction の考慮がある一方、`src/components/Terminal.tsx` は `ws://localhost:3000/terminal/...` に直接接続する前提で、現行のアプリ内 WebSocket 契約と整合していません。
- control mode は長寿命 subprocess と継続的な出力ストリームを導入するため、接続数・アイドル timeout・backpressure・ログ/描画境界の扱いを issue レベルで明示すべきです。

### 保守性

- 既存システムには `response-poller.ts`、`current-output/route.ts`、`ws-server.ts`、`tmux-capture-cache.ts` がそれぞれ別責務で存在しており、control mode を入れると二重経路が発生します。
- そのため、feature flag、capability fallback、observability、段階的 cleanup を issue 本文に入れないと「新旧二重運用が常態化する」リスクがあります。

## 主な不足点

1. terminal page と main worktree detail のスコープ境界が曖昧
2. `SessionTransport` が capability negotiation を持たず、streaming transport と polling transport の差を吸収しきれない
3. control mode の server-side resource management が未定義
4. セキュリティ要件が「既存 route の前提」に留まり、長寿命 stream の脅威モデルが不足
5. 成功基準が定性的で、性能改善と rollback 条件を判定しにくい

## 更新方針

- terminal page を Phase 1-2 の主対象として切り出し、main worktree detail への波及は別フェーズで定義
- `SessionTransport` を「snapshot transport と streaming transport を両立する抽象」として再定義
- feature flag と fallback 戦略を先に要求
- auth / worktree ownership / subscription cleanup / idle timeout / output handling を acceptance criteria に追加
- 性能計測を capture 回数、可視遅延、接続数・メモリ予算で定義

## 更新結果

- GitHub issue 本文を上記観点で再構成
- 元本文は `original-issue.json` として保存
- 更新後本文は `updated-issue-body.md` として保存
