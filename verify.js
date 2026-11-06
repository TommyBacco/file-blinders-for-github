#!/usr/bin/env node
// Usage: node verify.js <owner/repo> <pr-number>
//
// Runs the SHIPPED classifier (extracted live from content.js — single
// source of truth) over the changed files of a PR and prints which ones it
// would auto-mark, one per line on stdout (summary on stderr), so it can be
// diffed against the CLI:
//
//   node verify.js cubbit/cubbit 20537 > addon-picks.txt
//   gh mark-tests-viewed --dry-run 20537 | sed -n '1,/^--$/p' | sed '$d' > cli-picks.txt
//   diff cli-picks.txt addon-picks.txt   # must be empty
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [repo, pr] = process.argv.slice(2);
if (!repo || !pr) {
  console.error('Usage: node verify.js <owner/repo> <pr-number>');
  process.exit(1);
}

// Extract isTestFile from content.js (it contains no nested two-space
// closing braces, so the first '\n  }' ends the function).
const source = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
const match = source.match(/^  function isTestFile[\s\S]*?\n  }$/m);
if (!match) throw new Error('could not extract isTestFile from content.js');
// Indirect eval keeps this working under 'use strict' (direct eval there gets
// its own scope) — test harness only, never shipped inside the xpi.
const isTestFile = (0, eval)(`(${match[0]})`); // eslint-disable-line no-eval

const files = execFileSync('gh', [
  'api', `repos/${repo}/pulls/${pr}/files?per_page=100`, '--paginate',
  '--jq', '.[].filename'
]).toString().trim().split('\n');

const picks = files.filter((f) => isTestFile(f));
console.error(`verify: content.js classifies ${picks.length} of ${files.length} changed files as tests`);
process.stdout.write(picks.join('\n') + '\n');
