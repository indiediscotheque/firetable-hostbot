// An in-memory Realtime Database with the queries the publisher uses.
// `reads` lists every path read with once() and `writes` every path written,
// so tests can check what a job would cost; listeners (on) see later writes.
export function fakeDb(data) {
  const root = { v: data };
  const reads = [];
  const writes = [];
  const listeners = [];
  const parts = (p) => String(p || "").split("/").filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), root.v) ?? null;
  const children = (p) => {
    const v = get(p);
    return v && typeof v === "object" ? Object.assign({}, v) : {};
  };
  const put = (p, val) => {
    const ks = parts(p);
    let o = root, k = "v";
    for (const part of ks) { if (!o[k] || typeof o[k] !== "object") o[k] = {}; o = o[k]; k = part; }
    if (val === null || val === undefined) delete o[k]; else o[k] = JSON.parse(JSON.stringify(val));
  };
  // entries: a query's [key, value] pairs (listed), or a stored value
  const snapOf = (key, entries, listed) => ({
    key, val: () => (entries === null || entries === undefined ? null : listed ? Object.fromEntries(entries) : JSON.parse(JSON.stringify(entries))),
    forEach(cb) { (listed ? entries : Object.entries(entries || {})).some(([k, v]) => cb(snapOf(k, v))); }
  });
  const matches = (q, v) => !q.child || (v && v[q.child] !== undefined &&
    (q.start === undefined || v[q.child] >= q.start) && (q.end === undefined || v[q.child] <= q.end));
  const query = (p, q = {}) => ({
    orderByChild: (c) => query(p, { ...q, child: c }),
    startAt: (v) => query(p, { ...q, start: v }),
    endAt: (v) => query(p, { ...q, end: v }),
    equalTo: (v) => query(p, { ...q, start: v, end: v }),
    limitToLast: (n) => query(p, { ...q, last: n }),
    once: async () => {
      reads.push(p);
      const val = get(p);
      if (!q.child) return snapOf(parts(p).pop(), val);
      let list = Object.entries(val || {}).filter(([, v]) => matches(q, v))
        .sort((a, b) => (a[1][q.child] < b[1][q.child] ? -1 : a[1][q.child] > b[1][q.child] ? 1 : 0));
      if (q.last) list = list.slice(-q.last);
      return snapOf(parts(p).pop(), list, true);
    },
    // child events on a path's children (and a query's), from now on
    on: (event, cb) => {
      reads.push(p + " (listener)");
      const l = { p, q, event, cb, seen: new Map() };
      if (event === "value") {
        l.json = JSON.stringify(get(p));
        cb(snapOf(parts(p).pop(), get(p)));
        listeners.push(l);
        return cb;
      }
      for (const [k, v] of Object.entries(children(p))) {
        if (!matches(q, v)) continue;
        l.seen.set(k, JSON.stringify(v));
        if (event === "child_added") cb(snapOf(k, v));
      }
      listeners.push(l);
      return cb;
    }
  });
  // tell listeners on a parent what changed among its children
  const notify = () => {
    for (const l of listeners) {
      if (l.event === "value") {
        const json = JSON.stringify(get(l.p));
        if (json !== l.json) { l.json = json; l.cb(snapOf(parts(l.p).pop(), get(l.p))); }
        continue;
      }
      const now = children(l.p);
      for (const [k, v] of Object.entries(now)) {
        if (!matches(l.q, v)) continue;
        const json = JSON.stringify(v);
        const before = l.seen.get(k);
        l.seen.set(k, json);
        if (before === undefined && l.event === "child_added") l.cb(snapOf(k, v));
        else if (before !== undefined && before !== json && l.event === "child_changed") l.cb(snapOf(k, v));
      }
      for (const k of [...l.seen.keys()]) {
        if (k in now && matches(l.q, now[k])) continue;
        l.seen.delete(k);
        if (l.event === "child_removed") l.cb(snapOf(k, null));
      }
    }
  };
  let pushes = 0;
  const ref = (p = "") => Object.assign(query(p), {
    set: async (v) => { writes.push(p); put(p, v); notify(); },
    update: async (u) => { for (const [k, v] of Object.entries(u)) { writes.push((p ? p + "/" : "") + k); put(p + "/" + k, v); } notify(); },
    push: async (v) => {
      const key = "k" + String(++pushes).padStart(6, "0");
      writes.push(p + "/" + key);
      put(p + "/" + key, v);
      notify();
      return { key };
    }
  });
  return { ref, get, reads, writes };
}
