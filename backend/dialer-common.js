// Shared by the web backend (server.js) and the dialer engine
// (dialer-engine.js) so both apply exactly the same rules.

// One canonical form for comparing numbers (DNC lookups): digits only, and
// an Indian number written as 91xxxxxxxxxx / 0xxxxxxxxxx reduced to its 10
// digits, so "+91 98400 12345", "098400 12345" and "9840012345" all match.
function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

// Current wall-clock time in the campaign's timezone as "HH:MM:SS" - the
// server itself runs in UTC, so this can't just use new Date().getHours().
function localTimeIn(timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date());
}

function isWithinCallWindow(campaign) {
  const now = localTimeIn(campaign.timezone || 'Asia/Kolkata');
  return now >= campaign.call_window_start && now < campaign.call_window_end;
}

module.exports = { normalizePhone, localTimeIn, isWithinCallWindow };
