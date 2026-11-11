// An in-memory Realtime Database with the queries the publisher uses.
export function fakeDb(data) {
  const root = { v: data };
  const parts = (p) => String(p || "").split("/").filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), root.v) ?? null;
  const put = (p, val) => {
    const ks = parts(p);
    let o = root, k = "v";
    for (const part of ks) { if (!o[k] || typeof o[k] !== "object") o[k] = {}; o = o[k]; k = part; }
    if (val === null || val === undefined) delete o[k]; else o[k] = JSON.parse(JSON.stringify(val));
  };
  // entries: a query's [key, value] pairs (listed), or a stored value
  const snapOf = (key, entries, listed) => ({
    key, val: () => (entries === null ? null : listed ? Object.fromEntries(entries) : JSON.parse(JSON.stringify(entries))),
    forEach(cb) { (listed ? entries : Object.entries(entries || {})).some(([k, v]) => cb(snapOf(k, v))); }
  });
  const query = (p, q = {}) => ({
    orderByChild: (c) => query(p, { ...q, child: c }),
    startAt: (v) => query(p, { ...q, start: v }),
    endAt: (v) => query(p, { ...q, end: v }),
    equalTo: (v) => query(p, { ...q, start: v, end: v }),
    limitToLast: (n) => query(p, { ...q, last: n }),
    once: async () => {
      const val = get(p);
      if (!q.child) return snapOf(parts(p).pop(), val);
      let list = Object.entries(val || {}).filter(([, v]) => v && v[q.child] !== undefined)
        .filter(([, v]) => (q.start === undefined || v[q.child] >= q.start) && (q.end === undefined || v[q.child] <= q.end))
        .sort((a, b) => (a[1][q.child] < b[1][q.child] ? -1 : a[1][q.child] > b[1][q.child] ? 1 : 0));
      if (q.last) list = list.slice(-q.last);
      return snapOf(parts(p).pop(), list, true);
    }
  });
  const ref = (p = "") => Object.assign(query(p), {
    set: async (v) => put(p, v),
    update: async (u) => { for (const [k, v] of Object.entries(u)) put(p + "/" + k, v); }
  });
  return { ref, get };
}
