const elements = Object.fromEntries(['account', 'signin', 'signout', 'backup', 'status', 'retry', 'delete'].map(id => [id, document.getElementById(id)]));
let busy = false;
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
  elements.status.textContent = !state.configured ? 'Cloud backup is not configured in this build.' :
    state.error || (state.syncing ? 'Syncing…' : state.enabled ? `Backup on. ${state.lastSync ? `Last synced ${new Date(state.lastSync).toLocaleString()}.` : 'Waiting for first sync.'}` : 'Backup off. Local tracking continues.');
}
async function status() {
  const result = await chrome.runtime.sendMessage({ type: 'siteclock:cloud:status' });
  if (result.error) throw Error(result.error);
  render(result);
}
async function act(action) {
  if (busy) return;
  busy = true;
  for (const element of Object.values(elements)) if (element.matches('button, input')) element.disabled = true;
  elements.status.textContent = action === 'signin' ? 'Complete Google sign-in in the window that opens…' : 'Working…';
  try {
    const result = await chrome.runtime.sendMessage({ type: `siteclock:cloud:${action}` });
    if (result.error) throw Error(result.error);
    busy = false; render(result);
  } catch (error) {
    busy = false;
    await status().catch(() => {});
    elements.status.textContent = error.message;
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
