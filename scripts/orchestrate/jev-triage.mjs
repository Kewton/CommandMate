#!/usr/bin/env node
// 開いている Issue を Jev（TypeSafe の System One モデル）で採点する。使い方: docs/orchestrate/jev.md
// 使用例: node scripts/orchestrate/jev-triage.mjs [--skip 3508,3055] [--out jev-out.json]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const skip = new Set((arg('--skip') ?? '').split(',').filter(Boolean).map(Number));
const out = arg('--out');

const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const key = process.env.JEV_API_KEY ?? env.JEV_API_KEY;
if (!key) { console.error('JEV_API_KEY が .env にありません'); process.exit(1); }

const questions = {
  model: { type: 'choice', instructions: 'Which worker model should implement this GitHub issue, given the issue text', criteria: {
    antigravity: 'Easy: every change is fully specified as file:line plus replacement code, acceptance fully automatic, no dangerous area',
    sonnet: 'Medium: fix candidates or test checks are enumerated in the issue, only a closed judgement is left, acceptance automatic',
    opus: 'Hard: root cause not pinned to file:line, open design decision, needs real-device/screen verification, new module wiring, or touches tmux/session/auto-yes/detection/polling/hooks/security/db migration',
    human: 'Needs a human decision or non-code work (device testing, policy, release, external account)' } },
  impact: { type: 'score', instructions: 'User-facing or operational impact if this issue stays unfixed',
    criteria: ['Cosmetic, internal maintainability only', 'Degraded reliability or noisy automation, workaround exists', 'Wrong or unsafe behavior for users, or data/automation actions that cannot be trusted'] },
  ready: { type: 'noul', instructions: 'The issue text already pins down the cause and the fix location precisely enough to start implementing without further investigation' },
  urgent: { type: 'noul', instructions: 'Leaving this unfixed will keep causing wrong actions or false automation reports in the near term' },
};

const issues = JSON.parse(execFileSync('gh', ['issue', 'list', '--repo', 'Kewton/CommandMate', '--state', 'open', '--limit', '200', '--json', 'number,title,labels,body']));
const rows = [];
for (const i of issues.filter((x) => !skip.has(x.number))) {
  const state = `Title: ${i.title}\nLabels: ${i.labels.map((l) => l.name).join(',')}\n\n${(i.body ?? '').slice(0, 12000)}`;
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model: 'jev-latest', questions }) });
  if (!res.ok) { rows.push({ number: i.number, error: `${res.status}` }); continue; }
  const a = (await res.json()).answers;
  rows.push({ number: i.number, title: i.title.slice(0, 50), model: a.model.choice, modelConf: a.model.confidence,
    impact: a.impact.score, ready: a.ready.noul, urgent: a.urgent.noul });
}
rows.sort((x, y) => ((y.impact ?? 0) + (y.urgent ?? 0)) - ((x.impact ?? 0) + (x.urgent ?? 0)));
for (const r of rows) console.log(r.error ? `${r.number}\tERR ${r.error}` : [r.number, r.model, r.modelConf.toFixed(2), r.impact.toFixed(2), r.ready.toFixed(2), r.urgent.toFixed(2), r.title].join('\t'));
if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
