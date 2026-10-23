// Bulk user import: agent accounts from an Excel / CSV file.
//
// Columns (row 1, any order, any case): username, password, extension, team.
// Every row becomes an agent. The upload is checked first (planUserImport,
// pure) and the screen shows every problem; accounts are only created when
// the whole file is clean - all or nothing, so a half-imported floor can't
// happen. The same rules as Create user apply, including an own-teams
// login's (TL / manager): only into its teams, only free extensions or its
// own agents'.
//
// Passwords are hashed in a worker thread (hashPasswords): ~85 ms each, so a
// 500-row file is ~45 s of CPU that would otherwise stall live screens.
const path = require('path');
const { Worker } = require('worker_threads');
const { USERNAME_RE, checkPassword, extensionOutsideScope } = require('./users');

const MAX_USER_ROWS = 500;
const COLUMNS = ['username', 'password', 'extension', 'team'];

/**
 * rows [{ rowNum, values: { header: string } }] from readLeadUpload, and what
 * exists now -> { ready: [{ rowNum, username, password, extensionId, teamId }], problems: [{ rowNum, username, error }] }.
 *
 * ctx: usernames - Set of existing usernames, lower case
 *      extensions - Map extension name -> { id, enabled, userIds }
 *      teams - Map team name (lower case) -> id
 *      scope - null (all teams) or the login's { teamIds, agentIds }
 */
function planUserImport(headers, rows, ctx) {
  const missing = ['username', 'password', 'extension'].filter((c) => !headers.includes(c));
  if (missing.length)
    return { error: `the file needs the columns ${COLUMNS.join(', ')} (missing: ${missing.join(', ')})` };
  if (ctx.scope && !headers.includes('team'))
    return { error: 'the file needs a "team" column - every agent goes into one of your teams' };
  if (rows.length > MAX_USER_ROWS) return { error: `max ${MAX_USER_ROWS} users per file - split it` };

  const ready = [];
  const problems = [];
  const seen = new Map(); // lower-case username -> first row with it
  for (const { rowNum, values } of rows) {
    const username = (values.username || '').trim();
    const password = values.password || '';
    const extName = (values.extension || '').trim();
    const teamName = (values.team || '').trim();
    const fail = (error) => problems.push({ rowNum, username, error });

    if (!USERNAME_RE.test(username)) {
      fail('username must be 3-50 letters, digits, dots, dashes or underscores');
      continue;
    }
    const key = username.toLowerCase();
    if (ctx.usernames.has(key)) {
      fail('that username is already taken');
      continue;
    }
    if (seen.has(key)) {
      fail(`the same username is on row ${seen.get(key)}`);
      continue;
    }
    seen.set(key, rowNum);
    const pwError = checkPassword(password);
    if (pwError) {
      fail(pwError);
      continue;
    }
    const ext = extName ? ctx.extensions.get(extName) : null;
    if (!extName) {
      fail('extension is required');
      continue;
    }
    if (!ext) {
      fail(`extension ${extName} does not exist`);
      continue;
    }
    if (!ext.enabled) {
      fail(`extension ${extName} is disabled`);
      continue;
    }
    const outside = extensionOutsideScope(ctx.scope, ext.userIds);
    if (outside) {
      fail(outside);
      continue;
    }
    let teamId = null;
    if (teamName) {
      teamId = ctx.teams.get(teamName.toLowerCase()) ?? null;
      if (!teamId || (ctx.scope && !ctx.scope.teamIds.includes(teamId))) {
        fail(ctx.scope ? `team "${teamName}" is not one of yours` : `team "${teamName}" does not exist`);
        continue;
      }
    } else if (ctx.scope) {
      fail('team is required');
      continue;
    }
    ready.push({ rowNum, username, password, extensionId: ext.id, teamId });
  }
  return { ready, problems };
}

/** bcrypt hashes of the passwords, in order - computed in a worker thread. */
function hashPasswords(passwords) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'hashWorker.js'), { workerData: { passwords } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => code !== 0 && reject(new Error(`password hashing stopped (exit ${code})`)));
  });
}

module.exports = { COLUMNS, MAX_USER_ROWS, planUserImport, hashPasswords };
