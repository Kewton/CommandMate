'use strict';
/**
 * [Issue #4308] E2E webServer heap probe. Loaded with `node --require` only when
 * CM_E2E_HEAP_PROBE_DIR is set (CI). Samples heapUsed / heap_size_limit and keeps
 * the peak in <dir>/heap-<pid>.json. Every failure is swallowed: the probe must never
 * affect the server or the E2E verdict.
 * Also appends a time series (series-<pid>.jsonl: timestamp/pid/heapUsed/heapTotal/rss), capped at
 * MAX_SERIES_LINES per process. NOTE: a 1 s sampler does NOT guarantee the true instantaneous peak;
 * a spike shorter than the interval can be missed (the exit-time sample only narrows that gap).
 * Also a CLI: `node e2e-heap-probe.cjs summarize <dir>` appends one line to GITHUB_STEP_SUMMARY.
 */
const fs = require('fs');
const path = require('path');

const MB = 1024 * 1024;

/** Upper bound of JSONL lines per process (1 s interval => ~2.8 h). */
const MAX_SERIES_LINES = 10000;

function computeRatio(peakBytes, limitBytes) {
  if (!(limitBytes > 0) || !(peakBytes >= 0)) return null;
  return Math.round((peakBytes / limitBytes) * 1000) / 10;
}

/** Highest-peak record among parsed JSON records; invalid ones are ignored. */
function pickPeak(records) {
  let best = null;
  for (const r of records) {
    if (!r || typeof r.peakHeapUsed !== 'number' || typeof r.heapSizeLimit !== 'number') continue;
    if (!best || r.peakHeapUsed > best.peakHeapUsed) best = r;
  }
  return best;
}

function readRecords(dir) {
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^heap-.*\.json$/.test(f)) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      } catch {
        /* skip unreadable file */
      }
    }
  } catch {
    /* no dir */
  }
  return out;
}

function formatSummaryLine(record) {
  if (!record) return 'E2E heap probe: no data';
  const ratio = computeRatio(record.peakHeapUsed, record.heapSizeLimit);
  return `E2E heap peak: ${Math.round(record.peakHeapUsed / MB)}MB / limit ${Math.round(
    record.heapSizeLimit / MB
  )}MB = ${ratio}% (headroom ${Math.round((100 - ratio) * 10) / 10}%)`;
}

function summarize(dir, summaryFile) {
  try {
    const line = formatSummaryLine(pickPeak(readRecords(dir)));
    if (summaryFile) fs.appendFileSync(summaryFile, line + '\n');
    return line;
  } catch {
    return 'E2E heap probe: summary failed';
  }
}

/** One time-series line; null when the numbers are unusable. */
function buildSeriesRecord(pid, mem, now) {
  if (!mem || typeof mem.heapUsed !== 'number') return null;
  return {
    timestamp: new Date(now === undefined ? Date.now() : now).toISOString(),
    pid,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    rss: mem.rss,
  };
}

/** Append a series line unless the cap is reached. Returns the new line count. Never throws. */
function appendSeries(file, record, count, max) {
  try {
    if (!record || count >= (max === undefined ? MAX_SERIES_LINES : max)) return count;
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
    return count + 1;
  } catch {
    return count;
  }
}

function startProbe(dir, intervalMs, maxSeriesLines) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const v8 = require('v8');
    const file = path.join(dir, `heap-${process.pid}.json`);
    const seriesFile = path.join(dir, `series-${process.pid}.jsonl`);
    let seriesCount = 0;
    let peak = 0;
    let written = 0;
    const sample = () => {
      try {
        const mem = process.memoryUsage();
        const used = mem.heapUsed;
        seriesCount = appendSeries(seriesFile, buildSeriesRecord(process.pid, mem), seriesCount, maxSeriesLines);
        if (used > peak) peak = used;
        if (peak > written) {
          const limit = v8.getHeapStatistics().heap_size_limit;
          const rec = { pid: process.pid, peakHeapUsed: peak, heapSizeLimit: limit, ratioPercent: computeRatio(peak, limit) };
          fs.writeFileSync(file, JSON.stringify(rec));
          written = peak;
        }
      } catch {
        /* never throw */
      }
    };
    const t = setInterval(sample, intervalMs || 1000);
    t.unref();
    process.on('exit', sample);
    sample();
  } catch {
    /* never throw */
  }
}

module.exports = { MAX_SERIES_LINES, buildSeriesRecord, appendSeries, computeRatio, pickPeak, readRecords, formatSummaryLine, summarize, startProbe };

if (require.main === module) {
  if (process.argv[2] === 'summarize') {
    console.log(summarize(process.argv[3], process.env.GITHUB_STEP_SUMMARY));
  }
} else if (process.env.CM_E2E_HEAP_PROBE_DIR) {
  startProbe(process.env.CM_E2E_HEAP_PROBE_DIR);
}
