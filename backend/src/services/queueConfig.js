function slugify(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// ringinuse = no: never ring a member who is already on a call - essential
// once the dialer feeds the queue (an agent mid-call must not get a second
// customer). Optional in the regex so stanzas written before D7 still match.
// Ring-behavior fields live in a 6-line stanza in queues.conf, written
// without any brackets in the body - this regex relies on that to find
// exactly one stanza and nothing past the next queue's `[name]` line.
// Safe to build directly from asterisk_name since slugify() only ever
// produces [a-z0-9_], never a regex metacharacter.
function queueStanzaRegex(asteriskName) {
  return new RegExp(
    `\\n?\\[${asteriskName}\\]\\nstrategy = [^\\n]*\\ntimeout = [^\\n]*\\nretry = [^\\n]*\\ntimeoutrestart = [^\\n]*\\nannounce-frequency = [^\\n]*\\n(?:ringinuse = [^\\n]*\\n)?`,
  );
}

module.exports = { queueStanzaRegex, slugify };
