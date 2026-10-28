// Names in Asterisk (Cloud edition, docs/plans/TENANTS_PLAN.md part 3).
//
// Every company has extension 1001 and a queue called "sales" in its own
// database, but Asterisk has one list of endpoints and one list of queues.
// So on a multi-tenant install Asterisk sees them as <company>_1001 and
// <company>_sales (company codes never contain "_"); a single install keeps
// the plain names. Our tables always keep the plain names: only code that
// talks to Asterisk (ARI / AMI) uses these, and code that reads names back
// from Asterisk strips them with ownName / fromAsterisk.
// The trunk and customers' phone numbers are never renamed.
const tenancy = require('../tenancy');

const SEP = '_';

/** '<company>_' for the current company, '' on a single install. */
function prefix() {
  return tenancy.isMulti() ? `${tenancy.key()}${SEP}` : '';
}

/** An extension's endpoint name in Asterisk: 1001 -> acme_1001. */
const endpoint = (ext) => (ext ? `${prefix()}${ext}` : ext);

/** The PJSIP channel / endpoint of an extension: PJSIP/acme_1001. */
const pjsip = (ext) => `PJSIP/${endpoint(ext)}`;

/** A queue's name in Asterisk: sales -> acme_sales. */
const queue = (name) => (name ? `${prefix()}${name}` : name);

/** An Asterisk name -> { company, name }; on a single install company is ''. */
function fromAsterisk(astName) {
  const s = String(astName ?? '');
  if (!tenancy.isMulti()) return { company: '', name: s };
  const i = s.indexOf(SEP);
  return i > 0 ? { company: s.slice(0, i), name: s.slice(i + 1) } : { company: '', name: s };
}

/** The plain name if this Asterisk name belongs to the current company, else null. */
function ownName(astName) {
  if (!tenancy.isMulti()) return astName;
  const p = prefix();
  return typeof astName === 'string' && astName.startsWith(p) ? astName.slice(p.length) : null;
}

/** ARI's { endpoint: state } map cut down to the current company's lines, under their plain names. */
function ownEndpointStates(states) {
  if (!states || !tenancy.isMulti()) return states;
  const out = {};
  for (const [name, state] of Object.entries(states)) {
    const own = ownName(name);
    if (own !== null) out[own] = state;
  }
  return out;
}

module.exports = { SEP, prefix, endpoint, pjsip, queue, fromAsterisk, ownName, ownEndpointStates };
