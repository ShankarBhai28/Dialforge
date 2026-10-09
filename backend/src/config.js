const QUEUES_CONF_PATH = process.env.QUEUES_CONF_PATH || '/etc/asterisk/queues.conf';

const APP_NAME = 'dialforge-app';

// Live SIP trunk to nxtra (Tata Communications PSTN), set up in Phase 2.
// Real destination numbers route through this; our own test extensions
// (1001/1002) still dial directly, no trunk involved. Deployment-specific
// (a different server may use a different trunk provider), so it's an
// env var rather than a hardcoded constant, even though it's not a secret.
const TRUNK_ENDPOINT = process.env.TRUNK_ENDPOINT || 'dialforge-nxtra1';

const TRUNK_CALLER_ID = process.env.TRUNK_CALLER_ID || '8065098690'; // DID authorized on the trunk account for outbound CLI

module.exports = { APP_NAME, QUEUES_CONF_PATH, TRUNK_CALLER_ID, TRUNK_ENDPOINT };
