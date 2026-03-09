# Terminal Gateway 方針

## 比較対象

### 案 A: `ws-server.ts` を拡張

利点:

- 既存の auth / IP restriction / connection lifecycle を再利用しやすい
- browser 側の接続先を既存 app WebSocket と揃えやすい
- server.ts への追加初期化が小さい

懸念:

- 既存 room broadcast 用 message protocol と terminal stream protocol が混在する
- `subscribe/unsubscribe` と terminal session subscribe の責務が交錯しやすい

### 案 B: terminal 専用 gateway を別モジュールで追加

利点:

- terminal stream の protocol と room broadcast を分離できる
- subscriber / resize / backpressure / idle cleanup を terminal 専用で設計しやすい

懸念:

- auth / IP restriction 実装の重複リスクがある
- server.ts の upgrade ハンドリングが複雑化する

## 採用方針

**案 A を採用する。**

ただし、`ws-server.ts` に terminal stream protocol をそのまま混在させるのではなく、内部で terminal 用 handler を分離する。

## 採用理由

1. browser からの WebSocket 接続は既に認証・IP 制限つきで提供されている
2. terminal stream のためだけに別 upgrade 経路を増やすと、認証境界のずれが起きやすい
3. issue #460 の主価値は transport 導入であり、server upgrade 経路を増やすことではない

## 実装メモ

- 外部公開の WebSocket endpoint は既存 app socket を維持する
- terminal stream message は内部で専用 handler に委譲する
- room broadcast message と terminal stream message は type を分離する
- terminal stream 用 subscriber state は `TmuxControlRegistry` 側に持ち、`ws-server.ts` は認証済み socket の入口に留める
