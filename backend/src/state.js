// In-memory tracking of in-progress click-to-call attempts, keyed by our
// own call id (the calls.id row). Not persisted - if the backend restarts
// mid-call, this state is lost, but the DB row/event trail still exists.
const activeCalls = new Map();

// Correlates a native-queue call back to our own calls.id row: AMI's
// queue events identify channels by Asterisk's own channel name, not our
// database id, so this maps one to the other for the lifetime of the call.
const queueCallChannels = new Map();

module.exports = { activeCalls, queueCallChannels };
