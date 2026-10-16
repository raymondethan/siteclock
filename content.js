(() => {
  if (globalThis.__siteclockLoaded) return;
  globalThis.__siteclockLoaded = true;
  const HEARTBEAT_MS = 10_000;
  const host = document.createElement('siteclock-timer');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial !important; position: fixed !important; right: 18px !important;
        bottom: 18px !important; z-index: 2147483647 !important; display: block !important;
        color-scheme: dark !important; pointer-events: none !important; }
      .clock { display: flex; align-items: center; gap: 9px; padding: 10px 13px;
        background: rgba(23, 27, 32, .94); color: #f1f4f6; border: 1px solid #424950;
        border-radius: 11px; box-shadow: 0 4px 18px #0003;
        font: 12px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        -webkit-font-smoothing: antialiased; }
      .dot { width: 6px; height: 6px; border-radius: 50%; background: #78828b; }
      .dot.running { background: #91e0b5; box-shadow: 0 0 7px #91e0b533; }
      .brand { color: #aeb8c1; font-size: 11px; }
      .time { font-variant-numeric: tabular-nums; white-space: nowrap; }
      @media print { :host { display: none !important; } }
    </style>
    <div class="clock" role="timer" aria-label="SiteClock website time">
      <span class="dot"></span><span class="brand">SiteClock</span><span class="time">…</span>
    </div>`;
  const clock = shadow.querySelector('.clock');
  const time = shadow.querySelector('.time');
  const dot = shadow.querySelector('.dot');
  let state = null;
  let receivedAt = 0;
  let connected = true;
  let pending = false;

  function format(ms) {
    const seconds = Math.floor(Math.max(0, ms) / 1000);
    const hours = Math.floor(seconds / 3600);
    return `${hours ? `${hours}h ` : ''}${Math.floor(seconds / 60) % 60}m ${String(seconds % 60).padStart(2, '0')}s`;
  }

  function render() {
    if (!state) return;
    const elapsed = performance.now() - receivedAt;
    const running = connected && state.running && document.hasFocus()
      && document.visibilityState === 'visible' && elapsed <= state.maxGapMs;
    time.textContent = format(state.totalMs + (running ? elapsed : 0));
    dot.classList.toggle('running', running);
    clock.title = `${state.hostname} · All-time total${running ? '' : ' · Paused'}`;
  }

  function accept(next) {
    if (!next || next.error || typeof next.totalMs !== 'number') return;
    if (state && next.asOf < state.asOf) return;
    state = next;
    receivedAt = performance.now();
    render();
  }

  async function heartbeat() {
    if (!host.isConnected) document.documentElement.append(host);
    if (pending || !connected || document.visibilityState !== 'visible') return;
    pending = true;
    try {
      accept(await chrome.runtime.sendMessage({ type: 'siteclock:heartbeat' }));
    } catch (error) {
      // Reloading an unpacked extension invalidates existing content scripts.
      if (!chrome.runtime?.id) {
        connected = false;
        clock.title = 'SiteClock was reloaded. Refresh this page to reconnect.';
        clearInterval(heartbeatTimer);
        clearInterval(renderTimer);
      }
    } finally { pending = false; }
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'siteclock:state') accept(message);
  });
  document.addEventListener('visibilitychange', () => { render(); void heartbeat(); });
  window.addEventListener('focus', () => { void heartbeat(); });
  window.addEventListener('blur', render);
  window.addEventListener('pageshow', () => { void heartbeat(); });
  window.addEventListener('pagehide', () => { void heartbeat(); });
  const heartbeatTimer = setInterval(() => { void heartbeat(); }, HEARTBEAT_MS);
  const renderTimer = setInterval(render, 1000);
  void heartbeat();
})();
