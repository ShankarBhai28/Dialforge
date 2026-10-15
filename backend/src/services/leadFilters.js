// The admin lead filters, shared by the Leads table, Export and bulk actions
// "all leads matching these filters" - so all three always mean the same leads.
// ?q= (name or phone) &campaignId= (or 'none') &listId= &status=
// &assignedTo= (a user id, or 'none' = not given to anyone)
const { normalizePhone } = require('../../dialer-common');
const { likeTerm, whereClause } = require('./paging');
const { scopeCondition } = require('./access');

function leadWhere(query, scope) {
  const { q, campaignId, listId, status, assignedTo } = query || {};
  const text = typeof q === 'string' ? q.trim() : '';
  const digits = normalizePhone(text);
  return whereClause([
    ['l.deleted_at IS NULL', []],
    [
      text ? `(l.name LIKE ?${digits ? ' OR l.phone LIKE ?' : ''})` : '',
      text ? [likeTerm(text), ...(digits ? [likeTerm(digits)] : [])] : [],
    ],
    [
      campaignId === 'none' ? 'l.campaign_id IS NULL' : campaignId ? 'l.campaign_id = ?' : '',
      campaignId && campaignId !== 'none' ? [campaignId] : [],
    ],
    [listId ? 'l.list_id = ?' : '', [listId]],
    [status ? 'l.status = ?' : '', [status]],
    [
      assignedTo === 'none' ? 'l.assigned_user_id IS NULL' : assignedTo ? 'l.assigned_user_id = ?' : '',
      assignedTo && assignedTo !== 'none' ? [assignedTo] : [],
    ],
    scopeCondition(scope, 'campaigns', 'l.campaign_id'),
  ]);
}

module.exports = { leadWhere };
