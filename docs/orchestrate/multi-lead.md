# 複数のリーダーで回すときの持ち分の細部

元の場所: [team.md](team.md) §10（#4546 で移した。文は元のまま）。規則は team.md §10 に残っている。

## 根拠

元の場所: team.md §10（冒頭）

根拠: `workspace/orchestration/runs/2026-11-17/leader2-onboarding.md` §2 と `pm-reply-leader2-rules.md`。

## 既定の分け方

元の場所: team.md §10 の 1

既定の分け方は、画面＝`src/app` の画面・`src/components`・`src/hooks`／CLI・サーバー＝`src/cli`・`src/app/api`・`src/lib`。

## 境界のファイル

元の場所: team.md §10 の 2

共有の型（`src/types/**`・`src/cli/types/api-responses.ts`）・API の呼び口（`src/lib/api-client*.ts`）・DB の migration（版の番号は計画で割り当てる）・試験の基盤（`tests/setup.ts`・`tests/helpers/**`・`vitest.config.ts`）・文言（`locales/{ja,en}/*.json`）・文書（`docs/module-reference.md`・`docs/user-guide/cli-operations-guide.md`・`.env.example`）。
