// Thin async wrapper mimicking the better-sqlite3-style API used by the
// original Express server (db.prepare(sql).get/all/run(...params)), but
// backed by Cloudflare D1 (which is async).
//
// Usage: const db = wrap(c.env.DB); const row = await db.prepare(sql).get(a, b);

// Running tally of rows written (only exposed when DEBUG_WRITES is set, for local measurement).
const stats = { rowsWritten: 0, statements: 0 };

function wrap(D1) {
  return {
    prepare(sql) {
      const stmt = D1.prepare(sql);
      return {
        async get(...params) {
          return stmt.bind(...params).first();
        },
        async all(...params) {
          const res = await stmt.bind(...params).all();
          return res.results || [];
        },
        async run(...params) {
          const res = await stmt.bind(...params).run();
          // Mirror better-sqlite3's RunResult shape used in the original code:
          // info.lastInsertRowid
          const meta = res.meta || {};
          stats.statements++; stats.rowsWritten += meta.rows_written || 0;
          return {
            lastInsertRowid: meta.last_row_id,
            changes: meta.changes
          };
        }
      };
    }
  };
}

module.exports = { wrap, stats };
