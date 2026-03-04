# Issue #403 仮説検証レポート

## 検証日時
- 2026-03-03

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `logs/server.log`にローテーション機能がない | Confirmed | `scripts/build-and-start.sh`にローテーション処理なし |
| 2 | `server.log`が無制限に肥大化する | Confirmed | `nohup npm start >> "$LOG_FILE" 2>&1 &`で追記のみ |
| 3 | 手動で`> logs/server.log`を実行する運用になっている | Unverifiable | コードから確認不可（運用上の話） |
| 4 | `scripts/build-and-start.sh`または`dist/server/server.js`起動時に実行 | Partially Confirmed | `build-and-start.sh`は存在するが`dist/server/`は存在しない |

## 詳細検証

### 仮説 1: `logs/server.log`にローテーション機能がない

**Issue内の記述**: 「現在ログローテーションが存在せず、`server.log`が無制限に肥大化する」

**検証手順**:
1. `scripts/build-and-start.sh`を確認
2. ログ関連ファイル（`src/lib/log-manager.ts`, `src/lib/logger.ts`, `src/config/log-config.ts`）を確認
3. `grep -r "rotation\|rotate\|logrotate" src/ scripts/`で実装確認

**判定**: Confirmed

**根拠**:
- `scripts/build-and-start.sh`の`LOG_FILE="$LOG_DIR/server.log"`は追記のみ
- `nohup npm start >> "$LOG_FILE" 2>&1 &`でサーバー出力を追記
- ローテーション処理のコードは一切存在しない

---

### 仮説 2: `server.log`が無制限に肥大化する

**Issue内の記述**: 「実測で46MB/182,000行に達しており、ディスクI/Oへの影響が懸念される」

**検証手順**:
1. `build-and-start.sh`のログ書き込み方式を確認
2. サイズ制限・ローテーションロジックの有無を確認

**判定**: Confirmed

**根拠**:
- `>>`（追記）モードのみ使用
- ファイルサイズチェック・ローテーション処理なし
- 46MB/182,000行の数値はコードから検証不可だが、追記方式から肥大化が起きることは事実

---

### 仮説 3: 手動で`> logs/server.log`を実行する運用

**Issue内の記述**: 「手動で`> logs/server.log`を実行する運用になっている」

**検証手順**: コードベース検索

**判定**: Unverifiable

**根拠**: これは運用上の話であり、コードから確認できない。ただし、ローテーション機能が存在しないことから、手動クリアが唯一の方法であることは論理的に正しい。

---

### 仮説 4: `dist/server/server.js`でのローテーション実装

**Issue内の記述**: 「`scripts/build-and-start.sh`または`dist/server/server.js`起動時にローテーション実行」

**検証手順**:
1. `ls dist/server/`で存在確認
2. ビルドスクリプトの出力先確認

**判定**: Partially Confirmed

**根拠**:
- `scripts/build-and-start.sh`は存在する（実装先として有効）
- `dist/server/`ディレクトリは存在しない（ビルド前のため）
- `tsconfig.server.json`の`build:server`でビルドされる可能性あり

**補足事項**:
- Issueでは`dist/server/server.js`と記載されているが、現時点でこのファイルは存在しない
- ログローテーションをシェルスクリプトに実装するか、Node.jsサーバー起動ロジックに実装するかの設計選択が必要

## 重要な追加発見

### 2種類のログシステムの存在

Issueは`logs/server.log`（サーバー起動ログ）に焦点を当てているが、プロジェクトには2種類のログシステムが存在する：

1. **`logs/server.log`**: `build-and-start.sh`が`nohup npm start`の出力をリダイレクト（シェルレベル）
2. **`data/logs/`**: `src/config/log-config.ts`の`getLogDir()`が返すディレクトリ（アプリケーションレベルの会話ログ）

Issueのスコープは`logs/server.log`（1番）のみ。`data/logs/`（2番）はスコープ外。

## Stage 1レビューへの申し送り事項

1. **実装場所の明確化が必要**: `dist/server/server.js`は存在しないため、ローテーションをシェルスクリプト（`build-and-start.sh`）かNode.jsアプリケーション起動時かを明確に定義すること
2. **2種類のログシステムの区別**: Issueの対象が`logs/server.log`のみであることを明記する
3. **ローテーション実行タイミング**: 「サーバー起動時」と「日次」が提案されているが、サーバー起動時のみで十分かどうかの検討が必要
4. **ファイルパスの整合性**: `build-and-start.sh`は`$PROJECT_DIR/logs/server.log`を使用しているが、Issueは`logs/server.log`と記載（プロジェクトルートからの相対パスとして整合している）
