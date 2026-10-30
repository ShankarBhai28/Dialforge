// One paging shape for every admin list:
//   request  ?page=1&pageSize=50   (page starts at 1; pageSize capped)
//   response { rows, total, page, pageSize }   total = rows matching the filters
function parsePaging(query, { defaultSize = 50, maxSize = 200 } = {}) {
  const page = Math.max(1, Math.floor(Number(query.page)) || 1);
  const size = Math.floor(Number(query.pageSize)) || defaultSize;
  const pageSize = Math.min(Math.max(1, size), maxSize);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function pageResult(rows, total, { page, pageSize }) {
  return { rows, total: Number(total), page, pageSize };
}

// For lists that grow by millions (the call log): count only up to COUNT_CAP
// rows past this page - an exact COUNT(*) read the whole table on every
// page. { total, more }: more = there are more than total ("of 10,050+").
const COUNT_CAP = 10000;
async function cappedCount(db, fromWhere, params, { offset }) {
  const cap = offset + COUNT_CAP;
  const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM (SELECT 1 ${fromWhere} LIMIT ?) t`, [...params, cap + 1]);
  const n = Number(r.n);
  return { total: Math.min(n, cap), more: n > cap };
}

/** Builds "WHERE a AND b" from the non-empty conditions, with their params in order. */
function whereClause(conditions) {
  const used = conditions.filter(([sql]) => sql);
  return {
    sql: used.length ? 'WHERE ' + used.map(([sql]) => sql).join(' AND ') : '',
    params: used.flatMap(([, params]) => params || []),
  };
}

/** For LIKE: a search term with % and _ taken literally. */
const likeTerm = (s) => `%${String(s).replace(/[\\%_]/g, (c) => '\\' + c)}%`;

module.exports = { parsePaging, pageResult, cappedCount, COUNT_CAP, whereClause, likeTerm };
