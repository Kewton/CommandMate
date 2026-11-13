'use strict';
/**
 * [Issue #4308] Playwright reporter: appends test start/end times to <dir>/timeline.jsonl so the
 * heap series (series-<pid>.jsonl, same dir) can be lined up with specs. Enabled by playwright.config.ts
 * only when CI and CM_E2E_HEAP_PROBE_DIR are set. Every failure is swallowed: it must never change
 * the E2E verdict. Lines are capped at MAX_TIMELINE_LINES.
 */
const fs = require('fs');
const path = require('path');

const MAX_TIMELINE_LINES = 20000;

class TimelineReporter {
  constructor(options) {
    this.dir = (options && options.dir) || process.env.CM_E2E_HEAP_PROBE_DIR || '';
    this.max = (options && options.max) || MAX_TIMELINE_LINES;
    this.count = 0;
    this.file = '';
    try {
      if (this.dir) {
        fs.mkdirSync(this.dir, { recursive: true });
        this.file = path.join(this.dir, 'timeline.jsonl');
      }
    } catch {
      this.file = '';
    }
  }

  write(rec) {
    try {
      if (!this.file || this.count >= this.max) return;
      fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
      this.count += 1;
    } catch {
      /* never throw */
    }
  }

  onTestBegin(test, result) {
    try {
      this.write({
        event: 'test-begin',
        timestamp: new Date().toISOString(),
        file: test.location && test.location.file ? path.basename(test.location.file) : '',
        title: test.title,
        retry: result && result.retry,
      });
    } catch {
      /* never throw */
    }
  }

  onTestEnd(test, result) {
    try {
      this.write({
        event: 'test-end',
        timestamp: new Date().toISOString(),
        file: test.location && test.location.file ? path.basename(test.location.file) : '',
        title: test.title,
        retry: result && result.retry,
        status: result && result.status,
        durationMs: result && result.duration,
      });
    } catch {
      /* never throw */
    }
  }

  printsToStdio() {
    return false;
  }
}

module.exports = TimelineReporter;
module.exports.MAX_TIMELINE_LINES = MAX_TIMELINE_LINES;
