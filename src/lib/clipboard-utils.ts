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

  // Primary: Clipboard API (requires HTTPS or localhost)
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(cleanText);
      return;
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: textarea + execCommand for non-secure contexts (e.g. mobile over HTTP)
  const textarea = document.createElement('textarea');
  textarea.value = cleanText;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}
