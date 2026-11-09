/**
 * The observation-point table of Issue #4288 (docs/design/verify-lock-holder-group-4288.md §2.8).
 *
 * One row per observation point: what it observes, which implementations make it, and what an
 * UNKNOWN answer (EPERM, EACCES, EIO, a listing that failed …) does there — never take, delete or
 * release. The design document carries the same table; lock-observation-points-4288.test.ts checks
 * that the two agree, that the points the code names (collected by lock-observation-scan-4288.ts)
 * are exactly these, and injects a failure at every (point × implementation) row.
 */
import type { Impl } from './lock-observation-scan-4288';

export interface ObservationPoint {
  point: string;
  impls: Impl[];
  /** 何を観測するか */
  observes: string;
  /** 不明のときの扱い（取らない・消さない・解放しない・始めない） */
  unknown: string;
}

const ALL: Impl[] = ['bash', 'ts', 'sync'];

export const OBSERVATION_POINTS: ObservationPoint[] = [
  { point: 'pid', impls: ALL, observes: 'kill -0 <pid>（保有者・札の pid）', unknown: '死んだと読まない: 回収しない（取らない）' },
  { point: 'group', impls: ALL, observes: 'kill -0 -<pgid>（記録のグループ）', unknown: '空と読まない: 回収しない・bash は解放しない' },
  { point: 'list-queue', impls: ALL, observes: '<name>.queue の一覧', unknown: '札が無いと読まない: その周回は先頭にならない（取らない）' },
  { point: 'list-root', impls: ALL, observes: 'lock root の一覧（退避名の探索）', unknown: '退避が無いと読まない: mkdir しない（取らない）' },
  { point: 'gone-lstat', impls: ALL, observes: '退避名の項目の lstat', unknown: 'mkdir しない（取らない）' },
  { point: 'gone-owner', impls: ALL, observes: '<name>.lock.gone-*/owner の読み', unknown: '空きと読まない: mkdir・回収・復元をしない' },
  { point: 'lock-owner', impls: ALL, observes: '<name>.lock/owner の読み（取得・復元の途中の判定）', unknown: '回収しない・空の <lock> を消さない' },
  { point: 'lock-list', impls: ALL, observes: '<name>.lock の中身の一覧（復元の途中か）', unknown: '空と読まない: <lock> を消さない・owner を移さない' },
  { point: 'mkdir-lock', impls: ALL, observes: 'mkdir <name>.lock（取得）', unknown: '取らない（TS・同期 JS は errno 付きで投げる、bash は待つ）' },
  { point: 'rename-aside', impls: ALL, observes: 'rename <lock> → <lock>.gone-*（回収）', unknown: '何もしない（消さない）' },
  { point: 'recover-owner', impls: ALL, observes: '退かした owner の読み（回収の確かめ）', unknown: '判定した記録と読まない: 消さずに戻す' },
  { point: 'restore-mkdir', impls: ALL, observes: 'mkdir <lock>（戻し）', unknown: '退避を残す（それが保有中として塞ぐ）' },
  { point: 'restore-rename', impls: ALL, observes: 'rename 退避/owner → <lock>/owner（戻し）', unknown: '空の <lock> を rmdir で戻し、退避を残す' },
  { point: 'reclaim-rename', impls: ALL, observes: 'rename 死んだ退避 → 自分の退避名', unknown: '何もしない（消さない）' },
  { point: 'reclaim-owner', impls: ALL, observes: '移した退避の owner の読み', unknown: '判定した記録と読まない: 消さない' },
  { point: 'release-owner', impls: ALL, observes: '解放の前の <lock>/owner の読み', unknown: '解放しない' },
  { point: 'release-list', impls: ALL, observes: '解放のときの lock root の一覧（自分の退避の片付け）', unknown: '片付けない（消さない）' },
  { point: 'handoff-group', impls: ['bash'], observes: 'ps -o pgid=（ゲートのグループ G の確かめ）', unknown: 'ゲートを始めない（stage=group）' },
  { point: 'handoff-token', impls: ['bash'], observes: '公開の前の owner の読み（T0 か）', unknown: 'ゲートを始めない・解放しない（stage=token）' },
  { point: 'handoff-publish', impls: ['bash'], observes: 'mv .owner-T1 → owner（公開）', unknown: 'ゲートを始めない（stage=mv）' },
  { point: 'handoff-verify', impls: ['bash'], observes: '公開の後の owner の読み直し（T1・G か）', unknown: 'ゲートを始めない（stage=verify）' },
  { point: 'handoff-signal', impls: ['bash'], observes: '本体の mkdir go（合図）', unknown: 'ゲートを始めない（stage=signal）' },
  { point: 'handoff-self', impls: ['bash'], observes: '子の kill -0 <本体>', unknown: '本体が生きていると読まない: 取り下げて exec しない' },
  { point: 'handoff-go', impls: ['bash'], observes: '子の取り下げの mkdir go', unknown: '合図と読まない: exec しない' },
  { point: 'handoff-ack', impls: ['bash'], observes: '子の mkdir ack（受け取りの印）', unknown: 'exec しない（stage=ack）' },
  { point: 'handoff-watch', impls: ['bash'], observes: '見張りの kill -0 -G（ack の前）', unknown: 'G が空と読まない: 見張りを続ける（signal は送らない）' },
];

export interface RawCallAllowance {
  impl: Impl;
  fn: string;
  primitive: string;
  count: number;
  /** なぜ観測の関数を通さなくてよいか（判断に使わない／既に fail-closed） */
  why: string;
}

const OBSERVER = '観測の関数そのもの（3 値に分類する）';

export const RAW_CALL_ALLOWANCES: RawCallAllowance[] = [
  { impl: 'bash', fn: 'lock_kill0_raw', primitive: 'kill -0', count: 1, why: OBSERVER },
  { impl: 'bash', fn: 'lock_obs_list', primitive: 'ls', count: 1, why: OBSERVER },
  { impl: 'bash', fn: 'lock_obs_lstat', primitive: 'ls', count: 1, why: OBSERVER },
  { impl: 'bash', fn: 'lock_obs_owner', primitive: 'cat', count: 1, why: OBSERVER },
  { impl: 'bash', fn: 'lock_obs_mkdir', primitive: 'mkdir', count: 1, why: OBSERVER },
  { impl: 'bash', fn: 'lock_obs_mv', primitive: 'mv', count: 1, why: OBSERVER },
  { impl: 'bash', fn: 'lock_obs_pgid', primitive: 'ps -o', count: 1, why: OBSERVER },
  { impl: 'bash', fn: 'lock_owner_field', primitive: 'owner field', count: 1, why: '定義の行' },
  { impl: 'bash', fn: 'lock_pid_start_ms', primitive: 'ps -o', count: 1, why: '札の pid の再利用の判定。ps が答えなければ空で、札を外さない（待つ）' },
  { impl: 'bash', fn: 'lock_mark_done', primitive: 'mv', count: 1, why: '札の書き込み（行為）。失敗は札を残すだけ' },
  { impl: 'bash', fn: 'lock_acquire', primitive: 'mkdir', count: 2, why: 'root と .queue の mkdir -p（置き場を作るだけ。失敗は次の一覧・取得の観測に出る）' },
  { impl: 'bash', fn: 'lock_acquire', primitive: 'owner field', count: 4, why: '待ちの表示（heldBy）と回収の文面の pid。判断に使わない' },
  { impl: 'bash', fn: 'run_gate_attempt', primitive: 'ps -o', count: 1, why: 'mutex の無いゲートの timeout の宛先の確かめ（ロックの判断ではない。#4288 で変えない）' },
  ...(['ts', 'sync'] as const).flatMap((impl) => [
    ...['process.kill', 'readdirSync', 'lstatSync', 'readFileSync', 'mkdirSync', 'renameSync'].map((primitive) => ({ impl, fn: 'makeObserver', primitive, count: 1, why: OBSERVER })),
    { impl, fn: 'readJson', primitive: 'readFileSync', count: 1, why: '札の読み。読めない札は null で、生きている札と同じく塞ぎ、外さない' },
    { impl, fn: 'readOwner', primitive: 'readOwner', count: 1, why: '定義の行' },
    { impl, fn: 'ticketNumbers', primitive: 'readdirSync', count: 1, why: 'obs の無い呼び出し（ゴミ集め・export の listQueue）だけ。失敗は空で、何も消さない。取得は obs の list-queue を通る' },
    { impl, fn: 'markDone', primitive: 'renameSync', count: 1, why: '札の書き込み（行為）。失敗は札を残すだけ' },
    { impl, fn: 'takeTicket', primitive: 'mkdirSync', count: 1, why: '.queue の mkdir -p（置き場を作るだけ）' },
    { impl, fn: 'collectGarbage', primitive: 'readdirSync', count: 1, why: '札の一時ファイルの片付け。失敗は何も消さない' },
  ]),
  { impl: 'ts', fn: 'acquireMachineLock', primitive: 'mkdirSync', count: 1, why: 'root の mkdir -p（置き場を作るだけ）' },
  { impl: 'ts', fn: 'acquireMachineLock', primitive: 'readOwner', count: 1, why: '待ちの表示（heldBy）。判断に使わない' },
  { impl: 'sync', fn: 'pidAlive', primitive: 'process.kill', count: 1, why: 'export の旧 API（EPERM は生きている）。取得は使わず、holderGone に渡されたときだけ alive／gone に写して 3 値の判定に通す' },
  { impl: 'sync', fn: 'groupAlive', primitive: 'process.kill', count: 1, why: '同上' },
  { impl: 'sync', fn: 'acquireMachineLockSync', primitive: 'mkdirSync', count: 1, why: 'root の mkdir -p（置き場を作るだけ）' },
  { impl: 'sync', fn: 'acquireMachineLockSync', primitive: 'readOwner', count: 2, why: '待ちの表示（heldBy）と setOwnerFields（自分の記録への書き足し。token が自分でなければ書かない）' },
  { impl: 'sync', fn: 'acquireMachineLockSync', primitive: 'renameSync', count: 1, why: 'setOwnerFields の書き込み（行為）' },
];
