/**
 * TmuxControlClient.sendInput（Issue #2767）
 *
 * control mode の stdin は tmux コマンドの列であって、ペインのキーボードではない。
 * 修正前は入力をそのまま書き込んでいたので、ブラウザ端末で打った行が tmux コマンドとして
 * 実行されていた（`kill-server` と打って Enter で全セッションが落ちる）。
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import {
  CONTROL_SEND_KEYS_CHUNK_BYTES,
  TmuxControlClient,
} from '@/lib/tmux/tmux-control-client';

function fakeChild(): { child: ChildProcessWithoutNullStreams; written: string[] } {
  const written: string[] = [];
  const stream = () => Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const child = Object.assign(new EventEmitter(), {
    stdin: { writable: true, write: (chunk: string) => { written.push(chunk); return true; } },
    stdout: stream(),
    stderr: stream(),
    kill: vi.fn(),
  });
  return { child: child as unknown as ChildProcessWithoutNullStreams, written };
}

function startedClient(sessionName = 'mcbd-command-code-wt-1') {
  const { child, written } = fakeChild();
  const client = new TmuxControlClient({ spawnProcess: () => child, idleTimeoutMs: 60_000 });
  client.start(sessionName);
  return { client, written };
}

describe('[#2767] sendInput は入力を tmux コマンドとして流さない', () => {
  it('入力を send-keys -H（16 進）に包んで 1 行で書く', () => {
    const { client, written } = startedClient();
    client.sendInput('ls\r');
    expect(written).toEqual(['send-keys -t =mcbd-command-code-wt-1: -H 6c 73 0d\n']);
    client.stop();
  });

  it('tmux コマンドに見える入力も、ただのバイト列として届ける', () => {
    const { client, written } = startedClient();
    client.sendInput('kill-server\r');
    expect(written).toHaveLength(1);
    expect(written[0].startsWith('send-keys -t =mcbd-command-code-wt-1: -H ')).toBe(true);
    expect(written[0]).not.toContain('kill-server');
    client.stop();
  });

  it('制御文字・エスケープ列・UTF-8 をそのままのバイトで送る', () => {
    const { client, written } = startedClient();
    // `String.fromCharCode` rather than a `\u` escape: `gh issue view` rewrites
    // those escapes to caret notation, and this file was specified in an Issue.
    client.sendInput(String.fromCharCode(0x01));
    client.sendInput(`${String.fromCharCode(0x1b)}[A`);
    client.sendInput('あ;');
    expect(written).toEqual([
      'send-keys -t =mcbd-command-code-wt-1: -H 01\n',
      'send-keys -t =mcbd-command-code-wt-1: -H 1b 5b 41\n',
      'send-keys -t =mcbd-command-code-wt-1: -H e3 81 82 3b\n',
    ]);
    client.stop();
  });

  it('長い入力は CONTROL_SEND_KEYS_CHUNK_BYTES ごとに分けて送る', () => {
    const { client, written } = startedClient();
    client.sendInput('x'.repeat(CONTROL_SEND_KEYS_CHUNK_BYTES * 2 + 1));
    expect(written).toHaveLength(3);
    expect(written[0].trim().split(' -H ')[1].split(' ')).toHaveLength(CONTROL_SEND_KEYS_CHUNK_BYTES);
    expect(written[2]).toBe('send-keys -t =mcbd-command-code-wt-1: -H 78\n');
    client.stop();
  });

  it('start 前は投げる（書き込まない）', () => {
    const client = new TmuxControlClient({ spawnProcess: () => fakeChild().child });
    expect(() => client.sendInput('a')).toThrow('Tmux control client is not writable');
  });

  it('resize は従来どおり refresh-client を書く（このIssueで変えない）', () => {
    const { client, written } = startedClient();
    client.resize(120, 40);
    expect(written).toEqual(['refresh-client -C 120x40\n']);
    client.stop();
  });
});
