#!/usr/bin/env node
// Load test: makes the three files the test needs, in loadtest/out/:
//   agents-import.csv  - Users -> Import agents (loadagent5001 ... with
//                        extensions 5001 ..., all in the team you name)
//   leads.csv          - Leads -> import into the test campaign's list:
//                        fake numbers 9000000001 ... (they only ever reach
//                        the fake carrier)
//   sipp-agents.csv    - for SIPp on the load generator ("extension;password")
//
//   node loadtest/make-files.js --count 200 --team "Load test" \
//     --agent-password '<login password>' --sip-password '<SIP password>' [--from 5001] [--leads 20000]
//
// The two passwords are only for the throwaway test servers; the SIP one must
// match telephony-setup.sh --password.
const fs = require('fs');
const path = require('path');

const a = {};
for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const from = Number(a.from || 5001);
const count = Number(a.count);
const leads = Number(a.leads || 20000);
if (!count || !a.team || !a['agent-password'] || !a['sip-password']) {
  console.error('usage: --count N --team NAME --agent-password X --sip-password Y [--from 5001] [--leads 20000]');
  process.exit(2);
}
for (const k of ['agent-password', 'sip-password'])
  if (a[k].length < 8 || !/^[A-Za-z0-9._-]+$/.test(a[k])) {
    console.error(`--${k}: 8+ letters, digits, . _ -`);
    process.exit(2);
  }

const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
const exts = Array.from({ length: count }, (_, i) => from + i);
const csvTeam = /[",]/.test(a.team) ? `"${a.team.replace(/"/g, '""')}"` : a.team;

fs.writeFileSync(
  path.join(out, 'agents-import.csv'),
  ['username,password,extension,team', ...exts.map((e) => `loadagent${e},${a['agent-password']},${e},${csvTeam}`)].join(
    '\n',
  ) + '\n',
);
fs.writeFileSync(
  path.join(out, 'leads.csv'),
  ['name,phone', ...Array.from({ length: leads }, (_, i) => `Load test ${i + 1},${9000000001 + i}`)].join('\n') + '\n',
);
// SIPp injection file: first line says how to read it.
fs.writeFileSync(
  path.join(out, 'sipp-agents.csv'),
  ['SEQUENTIAL', ...exts.map((e) => `${e};${a['sip-password']}`)].join('\n') + '\n',
);
console.log(`written to ${out}: agents-import.csv (${count}), leads.csv (${leads}), sipp-agents.csv (${count})`);
