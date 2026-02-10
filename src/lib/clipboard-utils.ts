/**
 * ANSI escape code pattern for stripping terminal color codes.
 * Same pattern as cli-patterns.ts ANSI_PATTERN, duplicated here to avoid
 * importing server-side modules (cli-patterns → logger → env → fs) into
 * client-side code.
 *
 * Known limitations (SEC-002): 8-bit CSI, DEC private modes,
 * character set switching, some RGB color formats are not supported.
 * See src/lib/cli-patterns.ts ANSI_PATTERN for details.
 */
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\[[0-9;]*m/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_PATTERN, '');
}

/**
 * テキストをクリップボードにコピーする
 *
 * ANSIエスケープコードを除去してからコピーを実行します。
 *
 * @param text - コピー対象のテキスト
 * @throws Error - Clipboard APIが失敗した場合
 *
 * @remarks
 * - 空文字列または空白文字のみの入力は無視されます（早期リターン）
 */
export async function copyToClipboard(text: string): Promise<void> {
  // SF-S4-1: 空文字/空白文字バリデーション
  if (!text || text.trim().length === 0) {
    return;
  }

  const cleanText = stripAnsi(text);
  await navigator.clipboard.writeText(cleanText);
}
