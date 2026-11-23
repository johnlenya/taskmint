// In-memory stand-in for the platform database client, local tests only.
export class BackendError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

const clone = (row) => ({ ...row });

class Query {
  constructor(db, table, op, payload) {
    this.db = db; this.table = table; this.op = op; this.payload = payload;
    this.filters = []; this.limitN = Infinity; this.orderBy = null; this.conflict = null;
  }
  eq(column, value) { this.filters.push([column, value]); return this; }
  limit(n) { this.limitN = n; return this; }
  order(column, opts = {}) { this.orderBy = { column, ascending: opts.ascending !== false }; return this; }
  select() { return this; }
  then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject); }

  run() {
    const table = (this.db.tables[this.table] ||= []);
    const matches = (row) => this.filters.every(([c, v]) => row[c] === v);
    if (this.op === "select") {
      let out = table.filter(matches).map(clone);
      if (this.orderBy) {
        const { column, ascending } = this.orderBy;
        out.sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (ascending ? 1 : -1));
      }
      return { data: out.slice(0, this.limitN), error: null };
    }
    if (this.op === "insert" || this.op === "insertIfAbsent") {
      if (this.op === "insertIfAbsent") {
        const keys = this.conflict.split(",").map((k) => k.trim());
        if (table.some((row) => keys.every((k) => row[k] === this.payload[k]))) return { data: [], error: null };
      }
      table.push({ ...this.payload });
      return { data: [clone(this.payload)], error: null };
    }
    if (this.op === "update") {
      const hit = table.filter(matches);
      hit.forEach((row) => Object.assign(row, this.payload));
      return { data: hit.map(clone), error: null };
    }
    if (this.op === "delete") {
      const hit = table.filter(matches);
      this.db.tables[this.table] = table.filter((row) => !matches(row));
      return { data: hit.map(clone), error: null };
    }
    return { data: [], error: { code: "unsupported_op", status: 400 } };
  }
}

export function createFakeDb() {
  const db = { tables: {} };
  db.from = (table) => ({
    select: (cols, opts) => new Query(db, table, "select", { cols, opts }),
    insert: (row) => new Query(db, table, "insert", row),
    insertIfAbsent: (row, opts) => {
      const query = new Query(db, table, "insertIfAbsent", row);
      query.conflict = opts.onConflict;
      return query;
    },
    update: (patch) => new Query(db, table, "update", patch),
    delete: () => new Query(db, table, "delete", null),
  });
  return db;
}
