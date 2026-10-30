/* Account ownership and merge rules; no network or Chrome dependencies. */
globalThis.SiteClockSync = (() => {
  const copy = value => Object.assign(Object.create(null), value || {});
  function add(a, b) {
    const result = copy(a);
    for (const [host, ms] of Object.entries(b || {})) result[host] = (result[host] || 0) + ms;
    return result;
  }
  class Ledger {
    constructor(saved, legacyTotals, newId) {
      this.state = saved || {
        installationId: newId(), accountId: null, unassigned: copy(legacyTotals), accounts: {}
      };
      this.state.unassigned = copy(this.state.unassigned);
      for (const a of Object.values(this.state.accounts)) {
        for (const key of ['local', 'localOnly', 'acknowledged']) a[key] = copy(a[key]);
        for (const [id, counters] of Object.entries(a.remote)) a.remote[id] = copy(counters);
      }
    }
    get account() { return this.state.accountId ? this.state.accounts[this.state.accountId] : null; }
    local() { return this.account?.local || this.state.unassigned; }
    signIn(id, email) {
      if (!Object.hasOwn(this.state.accounts, id)) {
        this.state.accounts[id] = { email, local: copy(), localOnly: copy(), remote: {}, acknowledged: copy(), generation: null,
          enabled: false, lastSync: null, error: null, failures: 0, retryAt: 0 };
      }
      this.state.accountId = id;
      this.account.email = email;
    }
    signOut() {
      if (this.account) {
        this.account.enabled = false;
        this.account.remote = {};
      }
      this.state.accountId = null;
    }
    generation(value) {
      const a = this.account;
      if (!a) throw Error('Sign in first.');
      if (a.generation !== null && a.generation !== value) {
        a.localOnly = add(a.localOnly, a.local);
        a.local = copy(); a.remote = {}; a.acknowledged = copy(); a.enabled = false;
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
      return Object.entries(a.local).filter(([host, ms]) => ms > (a.acknowledged[host] || 0))
        .map(([hostname, totalMs]) => ({ hostname, totalMs }));
    }
    acknowledge(rows) {
      for (const { hostname, totalMs } of rows) {
        this.account.acknowledged[hostname] = Math.max(this.account.acknowledged[hostname] || 0, totalMs);
      }
    }
    merge(rows) {
      const a = this.account;
      for (const { installationId, hostname, totalMs } of rows) {
        if (installationId === this.state.installationId) continue;
        if (!Object.hasOwn(a.remote, installationId)) a.remote[installationId] = copy();
        const counters = a.remote[installationId];
        counters[hostname] = Math.max(counters[hostname] || 0, totalMs);
      }
    }
  }
  return { Ledger };
})();
