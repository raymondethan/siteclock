/* Account ownership and merge rules; no network or Chrome dependencies. */
globalThis.SiteClockSync = (() => {
  const copy = value => Object.assign(Object.create(null), value || {});
  function add(a, b) {
    const result = copy(a);
    for (const [host, ms] of Object.entries(b || {})) result[host] = (result[host] || 0) + ms;
    return result;
  }
  const buckets = value => Object.fromEntries(Object.entries(value || {}).map(([day, hosts]) => [day, copy(hosts)]));
  function addDays(a, b) {
    const result = buckets(a);
    for (const [day, hosts] of Object.entries(b || {})) result[day] = add(result[day], hosts);
    return result;
  }
  function localDay(at = Date.now(), offset = new Date(at).getTimezoneOffset()) {
    return new Date(at - offset * 60_000).toISOString().slice(0, 10);
  }
  function recentDays(at = Date.now()) {
    const today = localDay(at);
    const start = new Date(`${today}T12:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 6);
    return { from: start.toISOString().slice(0, 10), to: today };
  }
  class Ledger {
    constructor(saved, legacyTotals, newId) {
      this.state = saved || {
        installationId: newId(), accountId: null, unassigned: copy(legacyTotals), accounts: {}
      };
      this.state.unassigned = copy(this.state.unassigned);
      this.state.unassignedDaily = buckets(this.state.unassignedDaily);
      for (const a of Object.values(this.state.accounts)) {
        if (!a.periodVersion) { a.acknowledged = {}; a.periodVersion = 2; }
        for (const key of ['daily', 'localOnlyDaily', 'acknowledgedDaily']) a[key] = buckets(a[key]);
        a.remoteDaily ||= {};
        for (const [id, days] of Object.entries(a.remoteDaily)) a.remoteDaily[id] = buckets(days);
        for (const key of ['local', 'localOnly', 'acknowledged']) a[key] = copy(a[key]);
        for (const [id, counters] of Object.entries(a.remote)) a.remote[id] = copy(counters);
      }
    }
    get account() { return this.state.accountId ? this.state.accounts[this.state.accountId] : null; }
    local() { return this.account?.local || this.state.unassigned; }
    daily() { return this.account?.daily || this.state.unassignedDaily; }
    record(host, from, to, offset) {
      const local = this.local();
      local[host] = (local[host] || 0) + to - from;
      // Use the offset observed at the preceding checkpoint. Timezone changes
      // affect subsequent intervals; already assigned calendar dates stay fixed.
      while (from < to) {
        const day = localDay(from, offset);
        const midnight = (Math.floor((from - offset * 60_000) / 86_400_000) + 1) * 86_400_000 + offset * 60_000;
        const end = Math.min(to, midnight);
        const hosts = this.daily()[day] ||= copy();
        hosts[host] = (hosts[host] || 0) + end - from;
        from = end;
      }
    }
    periodTotals(from, to) {
      const a = this.account;
      let total = copy();
      const include = days => {
        for (const [day, hosts] of Object.entries(days || {})) {
          if (day >= from && day <= to) total = add(total, hosts);
        }
      };
      include(this.daily());
      if (a?.enabled) {
        for (const [id, remote] of Object.entries(a.remoteDaily)) {
          if (id !== this.state.installationId) include(remote);
        }
      } else if (a) { include(a.localOnlyDaily); include(this.state.unassignedDaily); }
      return total;
    }
    signIn(id, email) {
      if (!Object.hasOwn(this.state.accounts, id)) {
        this.state.accounts[id] = { email, local: copy(), localOnly: copy(), remote: {}, acknowledged: copy(), generation: null,
          periodVersion: 2, daily: {}, localOnlyDaily: {}, remoteDaily: {}, acknowledgedDaily: {}, enabled: false, lastSync: null, error: null, failures: 0, retryAt: 0 };
      }
      this.state.accountId = id;
      this.account.email = email;
    }
    signOut() {
      if (this.account) {
        this.account.enabled = false;
        this.account.remote = {}; this.account.remoteDaily = {};
      }
      this.state.accountId = null;
    }
    generation(value) {
      const a = this.account;
      if (!a) throw Error('Sign in first.');
      if (a.generation !== null && a.generation !== value) {
        a.localOnly = add(a.localOnly, a.local);
        a.localOnlyDaily = addDays(a.localOnlyDaily, a.daily);
        a.daily = {}; a.remoteDaily = {}; a.acknowledgedDaily = {};
        a.local = copy(); a.remote = {}; a.acknowledged = copy(); a.enabled = false;
        a.privacyMode = null; a.keyId = null;
        a.error = 'Cloud history was deleted. Enable backup again to start a new contribution.';
        a.generation = value;
        return false;
      }
      a.generation = value;
      return true;
    }
    enable(generation) {
      this.generation(generation);
      const a = this.account;
      a.local = add(a.local, this.state.unassigned);
      a.daily = addDays(a.daily, this.state.unassignedDaily);
      this.state.unassignedDaily = {};
      this.state.unassigned = copy();
      a.enabled = true; a.error = null; a.failures = 0; a.retryAt = 0;
    }
    pause() { if (this.account) this.account.enabled = false; }
    totals() {
      const a = this.account;
      if (!a) return copy(this.state.unassigned);
      let total = copy(a.local);
      if (a.enabled) {
        for (const [id, counters] of Object.entries(a.remote)) {
          if (id !== this.state.installationId) total = add(total, counters);
        }
      } else total = add(add(total, a.localOnly), this.state.unassigned);
      return total;
    }
    pending() {
      const a = this.account;
      // Pre-upgrade usage has no date. Upload it as the lifetime baseline,
      // separately from cumulative daily counters, never as today's usage.
      let dated = copy();
      for (const hosts of Object.values(a.daily)) dated = add(dated, hosts);
      const rows = Object.entries(a.local).map(([hostname, ms]) => ({ hostname, totalMs: ms - (dated[hostname] || 0) }))
        .filter(row => row.totalMs > (a.acknowledged[row.hostname] || 0));
      for (const [day, hosts] of Object.entries(a.daily)) {
        for (const [hostname, totalMs] of Object.entries(hosts)) {
          if (totalMs > (a.acknowledgedDaily[day]?.[hostname] || 0)) rows.push({ hostname, day, totalMs });
        }
      }
      return rows;
    }
    acknowledge(rows) {
      for (const { hostname, day, totalMs } of rows) {
        const counters = day ? (this.account.acknowledgedDaily[day] ||= copy()) : this.account.acknowledged;
        counters[hostname] = Math.max(counters[hostname] || 0, totalMs);
      }
    }
    merge(rows) {
      const a = this.account;
      for (const { installationId, hostname, totalMs, day } of rows) {
        if (installationId === this.state.installationId) continue;
        if (day) {
          const days = a.remoteDaily[installationId] ||= {};
          const counters = days[day] ||= copy();
          counters[hostname] = Math.max(counters[hostname] || 0, totalMs);
          continue;
        }
        if (!Object.hasOwn(a.remote, installationId)) a.remote[installationId] = copy();
        const counters = a.remote[installationId];
        counters[hostname] = Math.max(counters[hostname] || 0, totalMs);
      }
    }
  }
  return { Ledger, localDay, recentDays };
})();
