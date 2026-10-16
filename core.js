/* Shared, browser-independent accounting. No timers or storage side effects. */
globalThis.SiteClockCore = (() => {
  const HEARTBEAT_MS = 10_000;
  const MAX_GAP_MS = 25_000;
  const IDLE_SECONDS = 30 * 60;

  function hostname(url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      return parsed.hostname.toLowerCase().replace(/^www\./, '') || null;
    } catch { return null; }
  }

  function formatTime(ms) {
    const seconds = Math.floor(Math.max(0, ms) / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    return `${hours ? `${hours}h ` : ''}${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  }

  function sameActive(a, b) {
    return a === b || Boolean(a && b && a.tabId === b.tabId && a.hostname === b.hostname);
  }

  class Tracker {
    constructor(saved, sessionId, at) {
      this.totals = Object.create(null);
      for (const [host, ms] of Object.entries(saved?.totals || {})) {
        if (Number.isSafeInteger(ms) && ms >= 0) this.totals[host] = ms;
      }
      this.sessionId = sessionId;
      this.active = saved?.sessionId === sessionId ? saved.active : null;
      this.lastAt = saved?.sessionId === sessionId && Number.isFinite(saved.lastAt)
        ? saved.lastAt : at;
    }

    transition(next, at) {
      const gap = at - this.lastAt;
      let added = 0;
      // A long gap may be sleep, a clock change, or a missing content script.
      // Discard the uncertain interval rather than charge it to a website.
      if (this.active && gap > 0 && gap <= MAX_GAP_MS) {
        added = gap;
        const host = this.active.hostname;
        this.totals[host] = (this.totals[host] || 0) + added;
      }
      const changed = !sameActive(this.active, next);
      this.active = next;
      this.lastAt = at;
      return { added, changed };
    }

    snapshot(host, tabId) {
      return {
        hostname: host,
        totalMs: this.totals[host] || 0,
        running: Boolean(this.active && this.active.tabId === tabId && this.active.hostname === host),
        asOf: this.lastAt,
        maxGapMs: MAX_GAP_MS
      };
    }

    serialize() {
      return {
        version: 1, totals: { ...this.totals }, sessionId: this.sessionId,
        active: this.active, lastAt: this.lastAt
      };
    }
  }

  class SerialQueue {
    constructor() { this.tail = Promise.resolve(); }
    push(task) {
      const result = this.tail.then(task);
      // One failed save must not poison the queue. The caller handles the error.
      this.tail = result.catch(() => {});
      return result;
    }
  }

  return { HEARTBEAT_MS, MAX_GAP_MS, IDLE_SECONDS, hostname, formatTime, Tracker, SerialQueue };
})();
