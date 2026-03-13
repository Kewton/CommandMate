# Architecture Review: Issue #482 TODO/FIXME Marker Cleanup

## Basic Information

| Item | Value |
|------|-------|
| Issue | #482 |
| Review Stage | Stage 1 - Design Principles (通常レビュー) |
| Review Date | 2026-03-13 |
| Focus Area | 設計原則 (SOLID, KISS, YAGNI, DRY) |
| Status | **Approved** |
| Score | **5/5** |

---

## Executive Summary

Issue #482 の設計方針書は、コードベースに残存する4箇所のTODO/FIXMEマーカーを解消するための計画である。変更はすべてコメント・JSDocの修正に限定され、ランタイムの振る舞い・型定義・APIエンドポイントに一切影響しない。

設計原則の観点からレビューした結果、全項目で適切な判断がなされていることを確認した。特に以下の点が優れている:

- **YAGNI原則の適用**: 方針1でslash-commands/route.tsの型統合を行わない判断は、現時点で統合メリットがないことを正しく評価している
- **KISS原則の適用**: 方針2でfetchWithTimeoutの共通化を3つ目のprovider追加まで延期する判断は、早期最適化の回避として適切
- **DRY原則の適用**: 方針2でL217とL284の同一TODOコメント（2箇所の重複）をJSDocに集約する判断は、情報の一元管理に寄与する

must_fix/should_fixの指摘はなく、承認とする。

---

## Design Principles Checklist

### SOLID Principles

| Principle | Status | Comment |
|-----------|--------|---------|
| Single Responsibility | PASS | 各方針が単一のTODO/FIXMEに対応。変更範囲がコメント・JSDocに限定されている |
| Open/Closed | PASS | 型定義やAPIの振る舞いに変更なし。将来の拡張ポイントがJSDocに記録される |
| Liskov Substitution | N/A | コメント変更のみ |
| Interface Segregation | N/A | インターフェース変更なし |
| Dependency Inversion | N/A | 依存関係の変更なし |

### Other Principles

| Principle | Status | Comment |
|-----------|--------|---------|
| KISS | PASS | 最小限の変更でTODOを解消。早期最適化を避けている |
| YAGNI | PASS | 方針1の型統合不要判断、方針2のfetchWithTimeout共通化延期が適切 |
| DRY | PASS | 方針2でTODOコメント重複をJSDoc集約で解消 |

---

## Detailed Findings

### DR1-001 [nice_to_have] - DRY: fetchOllamaModels/fetchLmStudioModels の共通化判断

opencode-config.ts の2つのfetch関数は、HTTP fetch -> timeout -> response size check -> JSON parse -> model validation という同一フローを持つ。設計方針書ではTODOコメント削除とJSDoc集約のみを行い、共通化は3つ目のprovider追加時に実施する方針。

実際のコードを確認した結果:
- fetchOllamaModels() (L219-267) と fetchLmStudioModels() (L286-328) は構造が類似
- ただしOllamaはmodelのdetails（parameter_size, quantization_level）を処理するなど差分がある
- providerが2つのみの現状で共通化するとoverengineering

**判定**: 現方針は妥当。追加対応不要。

### DR1-002 [nice_to_have] - 設計方針書の完全性: JSDoc追記位置の明確化

方針2の対応内容で「ensureOpencodeConfig のJSDocに1行追記」とあるが、追記位置が「L340-342付近」とやや曖昧。実際にL340-342を確認したところ、既存JSDocに以下の記述がある:

```
Provider configuration is built dynamically: only providers with models are included.
If a 3rd provider is added, consider refactoring to a data-driven design
(providerDefinitions array + loop) instead of inline if-branches. [KISS]
```

追記文 `HTTP fetch logic (fetchWithTimeout) can be extracted to a shared helper.` はこの直後に配置するのが自然。

**判定**: 軽微。実装者が迷う可能性は低い。

### DR1-003 [nice_to_have] - 一貫性: NOTEコメント維持の判断

方針1でslash-commands/route.ts の NOTE コメント（L29-32）を維持する判断がなされている。このコメントは同名の型が2箇所に存在する理由を説明しており、TODOコメント削除後もコードの理解に有用。

**判定**: 適切な判断。変更不要。

---

## Risk Assessment

| Risk Type | Level | Description |
|-----------|-------|-------------|
| Technical | Low | コメント・JSDoc変更のみ。ランタイム影響なし |
| Security | Low | セキュリティ関連コードの変更なし |
| Operational | Low | ビルド・テスト・デプロイへの影響なし |

---

## Improvement Recommendations

### Must Fix (0 items)

None.

### Should Fix (0 items)

None.

### Consider (3 items)

1. **DR1-001**: fetchWithTimeoutの共通化タイミング（3つ目のprovider追加時）が既にJSDocに記録される予定。追加対応不要。
2. **DR1-002**: JSDoc追記位置をチェックリストに明記すると実装がスムーズになる。
3. **DR1-003**: NOTEコメント維持の判断は適切。

---

## Conclusion

設計方針書は設計原則（SOLID, KISS, YAGNI, DRY）の観点から適切に設計されている。全4箇所のTODO/FIXMEに対する対応方針が論理的に説明されており、各判断の根拠も明確。must_fix/should_fixの指摘はなく、承認とする。
