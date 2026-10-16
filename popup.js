const sites = document.getElementById('sites');

async function refresh() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'siteclock:summary' });
    if (!result || result.error) throw new Error(result?.error || 'Could not load totals.');
    const entries = Object.entries(result.totals).sort((a, b) => b[1] - a[1]);
    sites.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Visit a website to start your first clock.';
      sites.append(empty);
    }
    for (const [host, ms] of entries) {
      const row = document.createElement('div');
      row.className = 'site';
      if (result.active?.hostname === host) {
        const dot = document.createElement('span');
        dot.className = 'active';
        dot.title = 'Currently tracking';
        row.append(dot);
      }
      const label = document.createElement('span');
      label.className = 'hostname';
      label.textContent = host;
      label.title = host;
      const time = document.createElement('span');
      time.className = 'duration';
      time.textContent = SiteClockCore.formatTime(ms);
      row.append(label, time);
      sites.append(row);
    }
  } catch (error) { sites.textContent = error.message; }
}

void refresh();
setInterval(refresh, 10_000);
