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
  { point: 'restore-rename', impls: ALL, observes: 'link 退避/owner → <lock>/owner（戻し。#4288 PR1a-f I2-c で rename から link に。EEXIST は退避を残し <lock> を rmdir しない）', unknown: '空の <lock> を rmdir で戻し、退避を残す' },
  { point: 'reclaim-rename', impls: ALL, observes: 'rename 死んだ退避 → 自分の退避名', unknown: '何もしない（消さない）' },
  { point: 'reclaim-owner', impls: ALL, observes: '移した退避の owner の読み', unknown: '判定した記録と読まない: 消さない' },
  { point: 'reclaim-rmdir', impls: ALL, observes: 'rmdir 途中で止まった戻しの空の <lock>（回収の前）', unknown: '退避を残し、その周回は mkdir しない（取らない）。点・パス・errno を出す' },
  { point: 'release-owner', impls: ALL, observes: '解放の前の <lock>/owner の読み', unknown: '解放しない' },
  { point: 'release-list', impls: ALL, observes: '解放のときの lock root の一覧（自分の退避の片付け）', unknown: '片付けない（消さない）' },
  // #4288 PR1a (docs/design/lock-reservation-rest-4288.md §1.6 D3): the owner's exclusive create and
  // its read-back, and the age / rmdir of an owner-less <lock> (only with ownerlessGraceMs).
  { point: 'owner-create', impls: ALL, observes: 'tmp（<lock>/.owner-<token>）の排他作成（O_EXCL／set -C。#4288 PR1a-f I1）', unknown: '取らない。開いていないので何も消さず、自分の mkdir の <lock> を rmdir（空のときだけ）で戻す（TS・同期 JS は errno 付きで投げる）' },
  { point: 'owner-readback', impls: ALL, observes: '公開した owner の読み直し（自分の token か）', unknown: '取らない。owner を自分の名前 .undo-<token> へ rename し、tmp と同じ inode なら消して <lock> を戻す（I2-b）' },
  // #4288 PR1a-f (docs/design/machine-lock-owner-atomic-4288.md §5): the owner published whole (tmp →
  // link), the undo by an own name, the owner-less <lock> of temporaries (I3), the empty owner (I4), and
  // the option checks of the first acquisition (I1-b, I1-c).
  { point: 'owner-write', impls: ALL, observes: 'tmp への書き込み', unknown: '取らない。自分の tmp と自分の mkdir の <lock> を戻す' },
  { point: 'owner-write-short', impls: ALL, observes: 'tmp に書けたバイト数（TS・同期 JS は writeSync の戻り値の合計、bash は同じ取り方での読み直し）', unknown: '短い書き込みとして取らない。自分の tmp と <lock> を戻す' },
  { point: 'owner-close', impls: ['ts', 'sync'], observes: 'tmp の closeSync', unknown: '書けたと読まない: 取らない。自分の tmp と <lock> を戻す' },
  { point: 'owner-publish', impls: ALL, observes: 'link tmp → <lock>/owner（公開。EEXIST は在る owner を書き換えない・中に作らない）', unknown: '取らない。自分の tmp と <lock> を戻す（ENOENT は <lock> を rmdir しない）' },
  { point: 'owner-unlink', impls: ALL, observes: '自分の一時ファイル（.owner-<token>・.undo-<token>）の unlink', unknown: '残す（取った後なら tmp は解放・回収の rm -rf で消える。戻しなら <lock> も残る）' },
  { point: 'lock-rmdir', impls: ALL, observes: '戻しの rmdir（自分の mkdir の <lock>。空のときだけ消える）', unknown: '<lock> を残す（消さない）' },
  { point: 'owner-undo-rename', impls: ALL, observes: '戻しの rename <lock>/owner → <lock>/.undo-<token>', unknown: 'owner を消さない。自分の tmp だけ消し、<lock> を rmdir しない' },
  { point: 'owner-undo-lstat', impls: ALL, observes: '戻しの inode の確かめ（.undo-<token> と tmp の lstat）', unknown: '自分のものと読まない: link で <lock>/owner に戻す' },
  { point: 'owner-undo-link', impls: ALL, observes: '戻しの link .undo-<token> → <lock>/owner', unknown: '.undo-<token> を残して名指す（machine-lock-undo-restore-failed）' },
  { point: 'ownerless-tmp-lstat', impls: ['bash', 'sync'], observes: 'owner の無い <lock> の一時ファイルの lstat（種類と年齢）', unknown: '片付けない: その周回は mkdir しない（取らない）' },
  { point: 'owner-tmp-pid', impls: ['bash', 'sync'], observes: '旧版の owner.tmp.<pid> の pid の kill -0', unknown: '書き手でないと読まない: 片付けない・その周回は mkdir しない' },
  { point: 'ownerless-tmp-unlink', impls: ['bash', 'sync'], observes: '片付けの一時ファイルの unlink（ENOENT はもう無い）', unknown: 'rmdir も mkdir もしない（取らない）' },
  { point: 'empty-owner-move', impls: ALL, observes: '0 バイトの owner の <lock> を自分の退避名へ rename（I4）', unknown: '回収しない（取らない）' },
  { point: 'owner-pid', impls: ['bash', 'sync'], observes: '最初の取得の LOCK_OWNER_PID／ownerPid が自分か（I1-b）', unknown: '札も mkdir もせずに断る（取らない）' },
  { point: 'owner-fields', impls: ['bash', 'sync'], observes: '呼び手の欄（LOCK_OWNER_EXTRA／ownerFields）に予約の鍵が無いか（I1-c）', unknown: '札も mkdir もせずに断る（取らない）' },
  { point: 'ownerless-mtime', impls: ['bash', 'sync'], observes: 'owner の無い空の <lock> の mtime（ownerlessGraceMs の年齢）', unknown: '古いと読まない: <lock> を消さない・その周回は mkdir しない（取らない）' },
  { point: 'ownerless-rmdir', impls: ['bash', 'sync'], observes: '猶予を過ぎた owner の無い空の <lock> の rmdir', unknown: 'その周回は mkdir しない（取らない）。点・パス・errno を出す' },
  { point: 'handoff-group', impls: ['bash'], observes: 'ps -o pgid=（ゲートのグループ G の確かめ）', unknown: 'ゲートを始めない（stage=group）' },
  { point: 'handoff-token', impls: ['bash', 'sync'], observes: '公開の前の owner の読み（T0 か）', unknown: 'ゲートを始めない・解放しない（stage=token）' },
  { point: 'handoff-publish', impls: ['bash', 'sync'], observes: 'mv .owner-T1 → owner（公開）', unknown: 'ゲートを始めない（stage=mv）' },
  { point: 'handoff-verify', impls: ['bash', 'sync'], observes: '公開の後の owner の読み直し（T1・G か）', unknown: 'ゲートを始めない（stage=verify）' },
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
  { impl: 'bash', fn: 'lock_pid_start_ms', primitive: 'ps -o', count: 1, why: '札の pid と旧版の tmp の pid の再利用の判定。ps が答えない・形が不正・観測の間の時計の後退は空で、札を外さない・tmp を片付けない（#4288 PR1a-f F37・F53）' },
  { impl: 'bash', fn: 'lock_mark_done', primitive: 'mv', count: 1, why: '札の書き込み（行為）。失敗は札を残すだけ' },
  { impl: 'bash', fn: 'lock_acquire_path', primitive: 'mkdir', count: 2, why: 'root と .queue の mkdir -p（置き場を作るだけ。失敗は次の一覧・取得の観測に出る）' },
  { impl: 'bash', fn: 'lock_acquire_path', primitive: 'owner field', count: 4, why: '待ちの表示（held by の token の有無・pid・host・pgid）。判断に使わない（回収の pid は lock_obs_owner の 1 回の読みから渡す）' },
  { impl: 'bash', fn: 'run_gate_attempt', primitive: 'ps -o', count: 1, why: 'mutex の無いゲートの timeout の宛先の確かめ（ロックの判断ではない。#4288 で変えない）' },
  // The primitives the scan was widened to (Codex 5-2b P1 / PM review P2-2): JSON reads, test
  // operators, redirections, awk and rmdir.
  { impl: 'bash', fn: '<top>', primitive: 'test -d/-e/-f/-r/-x', count: 2, why: '引数の確かめ（--cwd・--config）。ロックの判断ではない' },
  { impl: 'bash', fn: '<top>', primitive: 'awk', count: 1, why: 'verify.yaml の構文解析。ロックの判断ではない' },
  { impl: 'bash', fn: 'lock_json_field', primitive: 'json field', count: 1, why: '定義の行' },
  { impl: 'bash', fn: 'lock_json_field', primitive: 'test -d/-e/-f/-r/-x', count: 1, why: '札の欄の読み手そのもの（下の札・表示の各行だけが使う）。owner の判断は lock_obs_owner の 1 回の読みから' },
  { impl: 'bash', fn: 'lock_json_field', primitive: 'awk', count: 1, why: '同上' },
  { impl: 'bash', fn: 'lock_json_text_field', primitive: 'json text field', count: 1, why: '定義の行（読み済みの文字列を解くだけで I/O をしない）' },
  { impl: 'bash', fn: 'lock_json_text_field', primitive: 'awk', count: 1, why: '同上' },
  { impl: 'bash', fn: 'lock_owner_field', primitive: 'json field', count: 1, why: '待ちの表示（held by）の読み手。判断に使わない' },
  { impl: 'bash', fn: 'lock_test_obs_fault', primitive: 'test -d/-e/-f/-r/-x', count: 1, why: 'テストの注入の口（CM_VERIFY_TEST_OBS_FAULT_FILE）。本番では読まない' },
  { impl: 'bash', fn: 'lock_test_obs_fault', primitive: 'read <', count: 1, why: '同上' },
  { impl: 'bash', fn: 'lock_test_pause', primitive: 'test -d/-e/-f/-r/-x', count: 1, why: 'テストの一時停止の口。本番では止まらない' },
  { impl: 'bash', fn: 'lock_obs_owner', primitive: 'json text field', count: 5, why: '観測の関数そのもの（1 回の読みから pid・host・token・pgid・v を解く）' },
  { impl: 'bash', fn: 'lock_ticket_retirable', primitive: 'cat', count: 1, why: '札の 1 回の読み（TS・同期 JS の readJson と同じ）。読めない札は外さない（生きた札と同じく塞ぐ）' },
  { impl: 'bash', fn: 'lock_ticket_retirable', primitive: 'json text field', count: 6, why: '上の 1 回の読みから欄を解く（読み直さない）' },
  { impl: 'bash', fn: 'lock_mark_done', primitive: 'json field', count: 2, why: '札の書き込み（行為）の前の確かめ。読めなければ書かない' },
  { impl: 'bash', fn: 'lock_take_ticket', primitive: 'test -d/-e/-f/-r/-x', count: 1, why: 'ln が EEXIST 以外で失敗したとき、その名前が在れば次の番号を試す。無ければ札を出さずに終わる（取らない）' },
  { impl: 'bash', fn: 'lock_collect_garbage', primitive: 'json field', count: 1, why: '使用済みの札の片付け。読めなければ消さない' },
  { impl: 'bash', fn: 'lock_move_owner_in', primitive: 'rmdir', count: 1, why: '戻しの rename の失敗で、この戻しが作った空の <lock> を戻す。失敗しても退避は残る（それが塞ぐ）' },
  { impl: 'bash', fn: 'lock_restore_from_gone', primitive: 'rmdir', count: 1, why: '戻す owner が ENOENT のとき、この戻しが作った空の <lock> を戻す。失敗は空のまま残すだけ' },
  { impl: 'bash', fn: 'lock_rmdir_errno', primitive: 'rmdir', count: 1, why: '失敗の errno を返す rmdir（観測の関数と同じく分類する）。lock_reclaim_gone が途中で止まった戻しの空の <lock> を戻すのに使い、失敗したら退避を消さずに残して点・パス・errno を報告する（Codex 再レビュー P2）' },
  { impl: 'bash', fn: 'lock_settle_gone', primitive: 'rmdir', count: 1, why: 'owner の無い（ENOENT）退避の片付け。空でなければ失敗して残るだけ' },
  { impl: 'bash', fn: 'lock_acquire_path', primitive: 'json field', count: 7, why: '自分の札の確かめ（読めなければ札を失ったとして列の最後へ）・前の札の done（読めなければ生きた札として扱う）・取り下げる札の token（lock_mark_done が確かめ直す）・待ちの表示。どれも読みの失敗が取る向きに働かない' },
  { impl: 'bash', fn: 'run_gate_attempt', primitive: 'test -d/-e/-f/-r/-x', count: 1, why: 'mutex の無いゲートの timeout の印。ロックの判断ではない' },
  { impl: 'bash', fn: 'lock_child_wait', primitive: 'test -d/-e/-f/-r/-x', count: 2, why: '子が合図（go）を見る。偽に倒れると exec しない向き。stat の失敗の扱いは追跡（PM review P3-3）' },
  // #4288 PR1a: the operations scripts/lib/machine-lock.sh loads (lock_acquire's body moved to lock_acquire_path,
  // lock_handoff_wait's to lock_child_wait — the same calls, counted under the new names above).
  { impl: 'bash', fn: 'lock_obs_create', primitive: 'cat', count: 2, why: '観測の関数そのもの（標準入力の記録を 1 回だけ読み、書いた tmp を同じ取り方で読み直して比べる。#4288 PR1a-f I1）' },
  { impl: 'bash', fn: 'lock_wait_head', primitive: 'mkdir', count: 1, why: '.queue の mkdir -p（置き場を作るだけ。失敗は次の一覧の観測に出る）' },
  { impl: 'bash', fn: 'lock_wait_head', primitive: 'json field', count: 4, why: 'lock_acquire_path と同じ札の確かめ（自分の札・前の札の done・取り下げる札の token）。読みの失敗は先頭にならない向き' },
  { impl: 'bash', fn: 'run_gate_handoff', primitive: 'test -d/-e/-f/-r/-x', count: 5, why: '見張りの ack・合図の取り下げ・ack の有無・timeout の印。ロックは G の排水（3 値）で守る。stat の失敗で報告がずれうる点は追跡（PM review P3-3）' },
  ...(['ts', 'sync'] as const).flatMap((impl) => [
    ...['process.kill', 'readdirSync', 'lstatSync', 'readFileSync', 'mkdirSync', 'renameSync', 'rmdirSync'].map((primitive) => ({ impl, fn: 'makeObserver', primitive, count: 1, why: OBSERVER })),
    { impl, fn: 'readJson', primitive: 'readFileSync', count: 1, why: '札の読み。読めない札は null で、生きている札と同じく塞ぎ、外さない' },
    { impl, fn: 'readOwner', primitive: 'readOwner', count: 1, why: '定義の行' },
    { impl, fn: 'ticketNumbers', primitive: 'readdirSync', count: 1, why: 'obs の無い呼び出し（ゴミ集め・export の listQueue）だけ。失敗は空で、何も消さない。取得は obs の list-queue を通る' },
    { impl, fn: 'markDone', primitive: 'renameSync', count: 1, why: '札の書き込み（行為）。失敗は札を残すだけ' },
    { impl, fn: 'takeTicket', primitive: 'mkdirSync', count: 1, why: '.queue の mkdir -p（置き場を作るだけ）' },
    { impl, fn: 'collectGarbage', primitive: 'readdirSync', count: 1, why: '札の一時ファイルの片付け。失敗は何も消さない' },
    // The primitives the scan was widened to (PM review P2-2).
    { impl, fn: 'readJson', primitive: 'readJson', count: 1, why: '定義の行' },
    { impl, fn: 'readOwner', primitive: 'readJson', count: 1, why: '待ちの表示（heldBy）と setOwnerFields の読み手。判断に使わない' },
    { impl, fn: 'readQueue', primitive: 'readJson', count: 1, why: '札の読み。読めない札は null で、生きている札と同じく塞ぎ、外さない' },
    { impl, fn: 'markDone', primitive: 'readJson', count: 1, why: '札の書き込み（行為）の前の確かめ。読めなければ書かない' },
    // Every clean-up delete goes through rmQuiet (#4288 PR1a-f impl-3, pm-return-4288-pr1af-impl-2 item 2):
    // a raw rmSync anywhere else is a delete whose failure may throw over the caller's answer.
    { impl, fn: 'rmQuiet', primitive: 'rmSync', count: 1, why: '後始末の削除の 1 か所（札の tmp・使用済みの札・退避・解放の <lock>。ENOENT は無視、ほかは errno を返して名指し、呼び手の戻り値・例外を上書きしない）' },
    { impl, fn: 'collectGarbage', primitive: 'readJson', count: 1, why: '使用済みの札の片付け。読めなければ消さない' },
    { impl, fn: 'collectGarbage', primitive: 'statSync', count: 1, why: '古い一時ファイルの判定。失敗は消さない' },
    { impl, fn: 'rmdirQuiet', primitive: 'rmdirSync', count: 1, why: '空のディレクトリだけを消す rmdir。失敗は残す向き（片付け・戻しの後始末だけ。reclaimGone は errno を持つ obs.rmdir を使う）' },
    { impl, fn: impl === 'ts' ? 'acquireMachineLock' : 'acquireMachineLockSync', primitive: 'readJson', count: 1, why: '自分の札の確かめ。読めなければ札を失ったとして列の最後に並び直す（取らない）' },
  ]),
  { impl: 'sync', fn: 'listQueue', primitive: 'readJson', count: 1, why: 'export の listQueue（表示・ゴミ集め用）。取得の判断は readQueue を通る' },
  { impl: 'ts', fn: 'acquireMachineLock', primitive: 'mkdirSync', count: 1, why: 'root の mkdir -p（置き場を作るだけ）' },
  { impl: 'ts', fn: 'acquireMachineLock', primitive: 'readOwner', count: 1, why: '待ちの表示（heldBy）。判断に使わない' },
  { impl: 'sync', fn: 'pidAlive', primitive: 'process.kill', count: 1, why: 'export の旧 API（EPERM は生きている）。取得は使わず、holderGone に渡されたときだけ alive／gone に写して 3 値の判定に通す' },
  { impl: 'sync', fn: 'groupAlive', primitive: 'process.kill', count: 1, why: '同上' },
  { impl: 'sync', fn: 'acquireMachineLockSync', primitive: 'mkdirSync', count: 1, why: 'root の mkdir -p（置き場を作るだけ）' },
  { impl: 'sync', fn: 'acquireMachineLockSync', primitive: 'readOwner', count: 2, why: '待ちの表示（heldBy）と setOwnerFields（自分の記録への書き足し。token が自分でなければ書かない）' },
  { impl: 'sync', fn: 'acquireMachineLockSync', primitive: 'renameSync', count: 1, why: 'setOwnerFields の書き込み（行為）' },
  { impl: 'sync', fn: 'asHead', primitive: 'readJson', count: 1, why: '自分の札の確かめ（releaseAsHead・recoverIfDead）。読めなければ札を失ったとして並び直す（先頭にならない）' },
];
