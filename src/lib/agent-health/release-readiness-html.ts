/**
 * The release-readiness HTML (Issue #3046): one self-contained file, no
 * external resources, readable in light and dark (`prefers-color-scheme`).
 *
 * Pure: takes the collected model, returns the HTML text. Everything that
 * came from outside (titles, Markdown, URLs) is escaped here.
 */

import type { DispatchRecord } from './dispatch-record';
import {
  CI_STATE_LABELS,
  formatDelta,
  VERDICT_LABELS,
  type CiState,
  type DispatchedIssueRow,
  type MetricComparison,
  type ReadinessDecision,
} from './release-readiness';

export interface ReleaseReadinessModel {
  date: string;
  generatedAt: string;
  repo: string;
  decision: ReadinessDecision;
  developCi: { state: CiState; ref: string; sha: string | null; runsUrl: string | null };
  release: {
    tag: string | null;
    commitsSince: number | null;
    fragments: Array<{ file: string; entry: string }> | null;
  };
  dispatch: DispatchRecord | null;
  dispatched: DispatchedIssueRow[];
  mergedToday: Array<{ number: number; title: string; url: string; checks: CiState }> | null;
  audit: { current: number | null; atLastRelease: number | null; source: string };
  metrics: {
    rows: MetricComparison[] | null;
    todayFile: string | null;
    previousDayDate: string | null;
    releaseDate: string | null;
  };
  openIssues: Array<{ number: number; title: string; url: string; labels: string[] }> | null;
  findings: { source: string; markdown: string } | null;
  summaries: Array<{ name: string; markdown: string }>;
  collectionErrors: string[];
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) links are rendered as links; anything else stays text. */
function link(url: string | null | undefined, label: string): string {
  if (!url || !/^https?:\/\//.test(url)) return escapeHtml(label);
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

function inlineMarkdown(text: string): string {
  // Escape first, then add the few inline forms back.
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

function tableCells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * A small Markdown subset — headings, lists, tables, fenced code, paragraphs —
 * enough for orchestrate summaries and findings. Raw HTML is escaped, never passed through.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      // Nested under the report's own h2/h3.
      const level = Math.min(6, heading[1].length + 3);
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const body = rows.filter((row) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(row));
      const [head, ...rest] = body;
      if (head === undefined) continue;
      const th = tableCells(head).map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('');
      const trs = rest
        .map((row) => `<tr>${tableCells(row).map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<div class="scroll"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`);
      continue;
    }
    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*(?:[-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(`<li>${inlineMarkdown(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(```|#{1,6}\s|\s*\||\s*(?:[-*]|\d+\.)\s+)/.test(lines[i])
    ) {
      paragraph.push(lines[i++]);
    }
    out.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
  }
  return out.join('\n');
}

function ciBadge(state: CiState): string {
  const tone = state === 'success' ? 'ok' : state === 'failure' ? 'bad' : 'warn';
  return `<span class="badge ${tone}">${escapeHtml(CI_STATE_LABELS[state])}</span>`;
}

function yesNo(value: boolean, yes: string, no: string): string {
  return `<span class="badge ${value ? 'ok' : 'warn'}">${escapeHtml(value ? yes : no)}</span>`;
}

function list(items: readonly string[], empty: string): string {
  if (items.length === 0) return `<p class="muted">${escapeHtml(empty)}</p>`;
  return `<ul>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`;
}

function issueUrl(repo: string, n: number): string {
  return `https://github.com/${repo}/issues/${n}`;
}

function verifyCell(exit: number | null): string {
  if (exit === null) return '<span class="muted">—</span>';
  return `<span class="badge ${exit === 0 ? 'ok' : 'bad'}">exit ${exit}</span>`;
}

function dispatchedTable(model: ReleaseReadinessModel): string {
  const { dispatch, dispatched, repo } = model;
  const header =
    dispatch === null
      ? '<p><strong>依頼なし</strong>（dispatch の記録がこの日には無い）</p>'
      : `<p>状態: <code>${escapeHtml(dispatch.status)}</code>${
          dispatch.sentAt ? `（送信 ${escapeHtml(dispatch.sentAt)}）` : ''
        }</p>`;
  if (dispatched.length === 0) {
    return `${header}${dispatch !== null ? '<p class="muted">依頼した Issue は無い。</p>' : ''}`;
  }
  const rows = dispatched
    .map((row) => {
      const reproduced =
        row.kind !== 'bug' || row.agentHealthKey === null
          ? ''
          : row.reproducedFail === true
            ? ' <span class="badge bad">develop で fail 再現</span>'
            : row.reproducedFail === false
              ? ' <span class="badge ok">develop で pass</span>'
              : ' <span class="badge warn">マージ後未確認</span>';
      return `<tr>
<td>${link(issueUrl(repo, row.number), `#${row.number}`)}<div class="sub">${escapeHtml(row.title)}</div></td>
<td>${escapeHtml(row.kind)}${row.agentHealthKey ? `<div class="sub"><code>${escapeHtml(row.agentHealthKey)}</code>${reproduced}</div>` : ''}</td>
<td>${row.agent ? escapeHtml(row.agent) : '<span class="muted">—</span>'}</td>
<td>${row.pr ? `${link(row.pr.url, `#${row.pr.number}`)} <span class="sub">${escapeHtml(row.pr.state)}</span>` : '<span class="muted">なし</span>'}</td>
<td>${row.pr ? ciBadge(row.ci) : '<span class="muted">—</span>'}</td>
<td>${verifyCell(row.verifyExit)}</td>
<td>${yesNo(row.merged, 'マージ済み', '未マージ')}</td>
<td>${row.commit ? `<code>${escapeHtml(row.commit.slice(0, 8))}</code>` : '<span class="muted">—</span>'}</td>
</tr>`;
    })
    .join('\n');
  return `${header}<div class="scroll"><table>
<thead><tr><th>Issue</th><th>種別</th><th>担当エージェント</th><th>PR</th><th>CI</th><th>verify</th><th>マージ</th><th>コミット</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

function developSection(model: ReleaseReadinessModel): string {
  const { developCi, release, mergedToday, audit } = model;
  const merged =
    mergedToday === null
      ? '<p class="muted">取得できず</p>'
      : mergedToday.length === 0
        ? '<p class="muted">本日マージされた PR は無い。</p>'
        : `<ul>${mergedToday
            .map((pr) => `<li>${link(pr.url, `#${pr.number}`)} ${escapeHtml(pr.title)} ${ciBadge(pr.checks)}</li>`)
            .join('')}</ul>`;
  const fragments =
    release.fragments === null
      ? '<p class="muted">取得できず</p>'
      : release.fragments.length === 0
        ? '<p class="muted">断片は無い。</p>'
        : `<ul>${release.fragments
            .map((fragment) => `<li><code>${escapeHtml(fragment.file)}</code> ${inlineMarkdown(fragment.entry)}</li>`)
            .join('')}</ul>`;
  return `<dl class="facts">
<dt>develop HEAD</dt><dd><code>${escapeHtml(developCi.ref)}</code> ${developCi.sha ? `<code>${escapeHtml(developCi.sha.slice(0, 8))}</code>` : ''} CI ${ciBadge(developCi.state)} ${developCi.runsUrl ? link(developCi.runsUrl, '実行一覧') : ''}</dd>
<dt>前回リリースタグ</dt><dd>${release.tag ? `<code>${escapeHtml(release.tag)}</code>` : '<span class="muted">不明</span>'}${
    release.commitsSince !== null ? ` からのコミット数 <strong>${release.commitsSince}</strong>` : ''
  }</dd>
<dt>npm audit（本番依存・high 以上）</dt><dd>今日 <strong>${audit.current ?? '—'}</strong> ／ 前回リリース時 ${audit.atLastRelease ?? '—'} <span class="sub">${escapeHtml(audit.source)}</span></dd>
</dl>
<h3>本日マージされた PR</h3>${merged}
<h3><code>changelog.d/</code> の断片</h3>${fragments}`;
}

function metricsSection(model: ReleaseReadinessModel): string {
  const { rows, todayFile, previousDayDate, releaseDate } = model.metrics;
  if (rows === null) {
    return '<p class="muted">この日の計測（<code>metrics/&lt;date&gt;.json</code>）は無い。</p>';
  }
  const body = rows
    .map(
      (row) => `<tr>
<td><code>${escapeHtml(row.metricId)}</code><div class="sub">${escapeHtml(row.summary)}</div></td>
<td>${escapeHtml(row.category)}</td>
<td><span class="badge ${row.status === 'pass' ? 'ok' : row.status === 'fail' ? 'bad' : 'warn'}">${escapeHtml(row.status)}</span></td>
<td class="num">${row.value ?? '—'}</td>
<td class="num">${row.previousDay ?? '—'} <span class="sub">${escapeHtml(formatDelta(row.value, row.previousDay))}</span></td>
<td class="num">${row.atLastRelease ?? '—'} <span class="sub">${escapeHtml(formatDelta(row.value, row.atLastRelease))}</span></td>
</tr>`
    )
    .join('\n');
  return `<p class="sub">今日: <code>${escapeHtml(todayFile ?? '')}</code> ／ 前日比の基準: ${escapeHtml(
    previousDayDate ?? 'なし'
  )} ／ 前回リリース比の基準: ${escapeHtml(releaseDate ?? 'なし')}</p>
<div class="scroll"><table><thead><tr><th>指標</th><th>分類</th><th>状態</th><th>値</th><th>前日（差）</th><th>前回リリース（差）</th></tr></thead>
<tbody>${body}</tbody></table></div>`;
}

function remainingSection(model: ReleaseReadinessModel): string {
  const { openIssues, dispatch, repo } = model;
  const open =
    openIssues === null
      ? '<p class="muted">取得できず</p>'
      : openIssues.length === 0
        ? '<p class="muted">open な Issue は無い。</p>'
        : `<ul>${openIssues
            .map(
              (issue) =>
                `<li>${link(issue.url, `#${issue.number}`)} ${escapeHtml(issue.title)} ${issue.labels
                  .map((label) => `<span class="tag">${escapeHtml(label)}</span>`)
                  .join(' ')}</li>`
            )
            .join('')}</ul>`;
  const deferred =
    dispatch && dispatch.deferred.length > 0
      ? `<ul>${dispatch.deferred.map((n) => `<li>${link(issueUrl(repo, n), `#${n}`)}</li>`).join('')}</ul>`
      : '<p class="muted">持ち越しは無い。</p>';
  const why =
    dispatch === null
      ? 'dispatch の記録が無い（依頼は行われていない）。'
      : dispatch.status === 'skipped-busy'
        ? 'orchestrate が実行中だったため依頼を見送った（skipped-busy）。'
        : dispatch.status === 'no-target'
          ? '依頼する対象が無かった（no-target）。'
          : dispatch.deferred.length > 0
            ? '上限を超えた分を持ち越した。'
            : '—';
  return `<h3>open な <code>agent-health</code>／<code>metrics</code> Issue</h3>${open}
<h3>持ち越し</h3>${deferred}
<h3>dispatch されなかった理由</h3><p>${escapeHtml(why)}</p>`;
}

function findingsSection(model: ReleaseReadinessModel): string {
  const parts: string[] = [];
  if (model.findings) {
    parts.push(`<p class="sub">所見: <code>${escapeHtml(model.findings.source)}</code></p>${markdownToHtml(model.findings.markdown)}`);
  }
  for (const summary of model.summaries) {
    parts.push(
      `<details${model.findings ? '' : ' open'}><summary>orchestrate の <code>${escapeHtml(summary.name)}</code></summary>${markdownToHtml(
        summary.markdown
      )}</details>`
    );
  }
  return parts.length > 0 ? parts.join('\n') : '<p class="muted">所見も orchestrate の summary も無い。</p>';
}

const STYLE = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--card:#f6f8fa;
--ok-bg:#dafbe1;--ok-fg:#116329;--warn-bg:#fff8c5;--warn-fg:#7d4e00;--bad-bg:#ffebe9;--bad-fg:#a40e26;--link:#0969da}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--card:#161b22;
--ok-bg:#12361f;--ok-fg:#56d364;--warn-bg:#3b2e0a;--warn-fg:#e3b341;--bad-bg:#42161a;--bad-fg:#ff7b72;--link:#4493f8}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--line)}
h3{font-size:15px;margin:20px 0 6px}h4,h5,h6{font-size:14px;margin:14px 0 4px}
a{color:var(--link)}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--card);padding:1px 4px;border-radius:4px}
pre{background:var(--card);padding:12px;border-radius:6px;overflow:auto}pre code{padding:0;background:none}
.muted,.sub{color:var(--muted)}.sub{font-size:12px}
.banner{border-radius:10px;padding:16px 20px;margin:16px 0;border:2px solid}
.banner .verdict{font-size:28px;font-weight:700;letter-spacing:.02em}
.banner.go{background:var(--ok-bg);color:var(--ok-fg);border-color:var(--ok-fg)}
.banner.hold{background:var(--warn-bg);color:var(--warn-fg);border-color:var(--warn-fg)}
.banner.no-go{background:var(--bad-bg);color:var(--bad-fg);border-color:var(--bad-fg)}
.banner ul{margin:8px 0 0;padding-left:20px;color:var(--fg)}
.badge{display:inline-block;font-size:12px;padding:0 8px;border-radius:999px;white-space:nowrap}
.badge.ok{background:var(--ok-bg);color:var(--ok-fg)}.badge.warn{background:var(--warn-bg);color:var(--warn-fg)}.badge.bad{background:var(--bad-bg);color:var(--bad-fg)}
.tag{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:0 6px;color:var(--muted)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{background:var(--card)}td.num{text-align:right;white-space:nowrap}
dl.facts{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}dl.facts dt{color:var(--muted)}dl.facts dd{margin:0}
details{border:1px solid var(--line);border-radius:6px;padding:8px 12px;margin:8px 0}summary{cursor:pointer}
@media (max-width:640px){dl.facts{grid-template-columns:1fr}dl.facts dd{margin-bottom:8px}}
`;

export function renderReleaseReadinessHtml(model: ReleaseReadinessModel): string {
  const { decision } = model;
  const errors =
    model.collectionErrors.length > 0
      ? `<h2>取得できなかった事実</h2>${list(model.collectionErrors, '')}`
      : '';
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>リリース判断 ${escapeHtml(model.date)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>リリース判断レポート ${escapeHtml(model.date)}</h1>
<p class="sub">${escapeHtml(model.repo)} ／ 生成 ${escapeHtml(model.generatedAt)} ／ 判定はスクリプトのルールで決まる（AI の所見は判定に使わない）</p>

<section class="banner ${decision.verdict}" aria-label="判定">
<div class="verdict">${escapeHtml(VERDICT_LABELS[decision.verdict])}</div>
${list(decision.reasons, '')}
</section>
${decision.notes.length > 0 ? `<h3>参考（判定には影響しない）</h3>${list(decision.notes, '')}` : ''}

<h2>次の一手</h2>
${list(decision.nextSteps, '')}

<h2>依頼した Issue</h2>
${dispatchedTable(model)}

<h2>develop の状態</h2>
${developSection(model)}

<h2>メトリクス</h2>
${metricsSection(model)}

<h2>残り・持ち越し</h2>
${remainingSection(model)}

<h2>AI の所見</h2>
${findingsSection(model)}
${errors}
</main>
</body>
</html>
`;
}
