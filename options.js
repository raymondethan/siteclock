const elements = Object.fromEntries(['account', 'signin', 'signout', 'backup', 'status', 'retry', 'delete', 'privacyMode', 'backupIntro'].map(id => [id, document.getElementById(id)]));
let busy = false;
let statusRequest;
function render(state) {
  elements.account.textContent = state.signedIn ? `Signed in as ${state.email || 'your Google account'}` : 'Not signed in. Your time is saved on this computer.';
  elements.signin.hidden = false;
  elements.signin.textContent = state.signedIn ? 'Switch or reconnect Google account' : 'Continue with Google';
  elements.signin.disabled = busy || !state.configured;
  elements.signout.hidden = !state.signedIn;
  elements.backup.checked = state.enabled;
  elements.backup.disabled = busy || !state.signedIn;
  elements.delete.disabled = busy || !state.signedIn;
  elements.retry.hidden = !state.enabled;
  elements.retry.disabled = busy;
  elements.signout.disabled = busy;
  const environment = state.environment === 'development'
    ? 'Development service: its backup is separate from production.'
    : state.environment === 'production' ? 'Production service.' : '';
  const serviceStatus = !state.configured ? 'Cloud backup is not configured in this build.' :
    state.error || (state.syncing ? 'Syncing…' : state.enabled ? `Backup on. ${state.lastSync ? `Last synced ${new Date(state.lastSync).toLocaleString()}.` : 'Waiting for first sync.'}` : 'Backup off. Local tracking continues.');
  elements.status.textContent = [environment, serviceStatus].filter(Boolean).join(' ');
  elements.privacyMode.textContent = !state.privacyMode ? 'Hostname privacy: choose a setting during backup setup.' :
    `Hostname privacy: ${state.privacyMode === 'recovery' ? 'encrypted with a recovery code' : state.privacyMode === 'device' ? 'encrypted for this Chrome profile' : 'unencrypted'}. Changing modes requires a local snapshot and confirmed cloud-history migration.`;
  elements.backupIntro.textContent = state.privacyMode === 'device'
    ? 'Device-only encryption keeps website names on this Chrome profile. Site names and matching totals from other computers cannot be combined.'
    : 'Sign in with the same Google account on each computer to back up your website totals. Recovery-code and unencrypted modes combine site totals.';
}
async function status() {
  if (statusRequest) return statusRequest;
  statusRequest = (async () => {
    let timeout;
    try {
      const result = await Promise.race([
        chrome.runtime.sendMessage({ type: 'siteclock:cloud:status' }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('SiteClock is taking too long to respond. Reload the extension and try again.')), 10_000); })
      ]);
      if (!result || result.error) throw Error(result?.error || 'SiteClock is reconnecting. Reload this settings page.');
      render(result);
    } catch (error) {
      elements.account.textContent = 'Account status unavailable. Local tracking continues.';
      // Keep account recovery available if only the status request failed.
      // Backup and deletion stay blocked until we know which account is active.
      elements.signin.disabled = false;
      elements.backup.disabled = true;
      elements.delete.disabled = true;
      elements.status.textContent = error.message;
      throw error;
    } finally {
      clearTimeout(timeout);
      statusRequest = null;
    }
  })();
  return statusRequest;
}
async function act(action) {
  if (busy) return;
  busy = true;
  for (const element of Object.values(elements)) if (element.matches('button, input')) element.disabled = true;
  elements.status.textContent = action === 'signin' ? 'Complete Google sign-in in the window that opens…' : 'Working…';
  let timeout;
  try {
    const result = await Promise.race([
      chrome.runtime.sendMessage({ type: `siteclock:cloud:${action}` }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(Error(action === 'signin'
          ? 'Sign-in is taking too long. Check for a Google sign-in window, then try again. Local tracking continues.'
          : 'SiteClock is taking too long to respond. Local tracking continues.')), 120_000);
      })
    ]);
    if (!result || result.error) throw Error(result?.error || 'SiteClock is reconnecting. Reload this settings page.');
    busy = false; render(result);
  } catch (error) {
    busy = false;
    await status().catch(() => {});
    elements.status.textContent = error.message;
  } finally {
    clearTimeout(timeout);
  }
}
elements.signin.addEventListener('click', () => act('signin'));
elements.signout.addEventListener('click', () => act('signout'));
elements.retry.addEventListener('click', () => act('retry'));
elements.backup.addEventListener('change', () => {
  if (elements.backup.checked && !confirm('Enable cloud backup? Existing unassigned website totals from this installation will be included in this account.')) {
    elements.backup.checked = false; return;
  }
  void act(elements.backup.checked ? 'enable' : 'pause');
});
elements.delete.addEventListener('click', () => {
  if (confirm('Delete cloud history across ALL installations? Backup will pause. Existing local contributions stay local and will not automatically upload again. Disaster-recovery copies expire within seven days.')) void act('delete');
});
void status().catch(error => { elements.status.textContent = error.message; });
setInterval(() => { if (!busy) void status().catch(() => {}); }, 5000);
