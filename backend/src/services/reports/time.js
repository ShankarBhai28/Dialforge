// Report dates are the center's local days, not UTC (times are stored in
// UTC). REPORT_TIMEZONE (IANA name, default Asia/Kolkata) decides what
// "today" and "10:00-11:00" mean. MySQL gets fixed offsets ('+05:30'), so it
// needs no time zone tables.
const ZONE = process.env.REPORT_TIMEZONE || 'Asia/Kolkata';
const MAX_DAYS = 366;

/** Minutes the zone is ahead of UTC at that instant. */
function offsetMinutes(date, zone = ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour, +v.minute, +v.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** 330 -> '+05:30' (MySQL CONVERT_TZ offset). */
function offsetSql(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const m = Math.abs(minutes);
  return `${sign}${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** UTC 'YYYY-MM-DD HH:MM:SS' for a Date. */
function sqlUtc(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** The UTC instant of local midnight starting that day. */
function localMidnight(ymd, zone = ZONE) {
  const guess = new Date(`${ymd}T00:00:00Z`);
  const first = new Date(guess.getTime() - offsetMinutes(guess, zone) * 60000);
  // Re-check at the found instant (a DST change near midnight).
  return new Date(guess.getTime() - offsetMinutes(first, zone) * 60000);
}

/** Today's local date, 'YYYY-MM-DD'. */
function localToday(now = new Date(), zone = ZONE) {
  return new Date(now.getTime() + offsetMinutes(now, zone) * 60000).toISOString().slice(0, 10);
}

const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/**
 * ?from=&to= (local days, inclusive; default today) -> the UTC window
 * [start, end) to compare stored times with, and the offset for showing
 * local times. Returns { error } for a bad range.
 */
function parseRange(query, now = new Date(), zone = ZONE) {
  const today = localToday(now, zone);
  const from = query.from || today;
  const to = query.to || query.from || today;
  if (!isYmd(from) || !isYmd(to)) return { error: 'dates must be YYYY-MM-DD' };
  if (from > to) return { error: '"from" must be on or before "to"' };
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (days > MAX_DAYS) return { error: `a report covers at most ${MAX_DAYS} days` };
  const start = localMidnight(from, zone);
  const nextDay = new Date(Date.parse(to) + 86400000).toISOString().slice(0, 10);
  const end = localMidnight(nextDay, zone);
  return {
    from,
    to,
    days,
    start: sqlUtc(start),
    end: sqlUtc(end),
    offset: offsetSql(offsetMinutes(start, zone)),
    zone,
  };
}

module.exports = { ZONE, offsetMinutes, offsetSql, sqlUtc, localMidnight, localToday, parseRange };
