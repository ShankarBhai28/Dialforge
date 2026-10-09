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

module.exports = { parsePaging, pageResult, whereClause, likeTerm };
