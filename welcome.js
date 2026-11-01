const ids = ['local', 'consent', 'backup', 'status', 'retry', 'browse', 'privacyChoices', 'recoveryCode', 'recoveryPanel', 'newRecoveryCode', 'savedCode', 'savedCodeLabel', 'migrationConsent', 'migrationConsentRow', 'recoveryHeading', 'recoveryInstructions', 'enableAfterRecovery', 'cancelMigration'];
const elements = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
let busy = false;
let state;
function mode() { return document.querySelector('input[name="privacyMode"]:checked')?.value || 'recovery'; }
function render() {
  elements.local.disabled = busy;
  elements.consent.disabled = busy;
  elements.backup.disabled = busy || !state?.configured || !elements.consent.checked || !elements.recoveryPanel.hidden;
  for (const choice of elements.privacyChoices.querySelectorAll('input')) choice.disabled = busy || Boolean(state?.privacyMode && state.privacyMode !== 'unencrypted') || !elements.recoveryPanel.hidden;
  elements.recoveryCode.disabled = busy;
  elements.savedCode.disabled = busy;
  elements.enableAfterRecovery.disabled = busy || !elements.consent.checked || (!elements.savedCodeLabel.hidden && !elements.savedCode.checked) || (!elements.migrationConsentRow.hidden && !elements.migrationConsent.checked);
  elements.retry.disabled = busy;
  elements.cancelMigration.disabled = busy;
}
async function send(action) {
  const result = await chrome.runtime.sendMessage({ type: `siteclock:cloud:${action}`, privacyMode: mode(),
    recoveryCode: elements.recoveryCode.value.trim(), savedRecoveryCode: elements.savedCode.checked, confirmMigration: elements.migrationConsent.checked });
  if (!result || result.error) throw Error(result?.error || 'SiteClock is reconnecting. Reload this page.');
  return result;
}
function describe() {
  if (state?.privacyMode) {
    const radio = document.querySelector(`input[name="privacyMode"][value="${state.privacyMode}"]`);
    if (radio) radio.checked = true;
  }
  elements.retry.hidden = !state?.enabled || !state.error;
  if (state?.enabled && state.lastSync && !state.error) {
    elements.status.textContent = state.privacyMode === 'device'
      ? 'Your encrypted backup is synced on this Chrome profile. Another computer cannot unlock or combine these site names.'
      : state.privacyMode === 'unencrypted' ? 'Your time is backed up. Sign in with the same Google account on other computers to combine site totals.'
        : 'Your time is backed up. Sign in with the same Google account and recovery code on other computers to combine site totals.';
    elements.browse.hidden = false;
  } else if (state?.error) {
    elements.status.textContent = state.error; elements.browse.hidden = false;
  } else if (state?.enabled) {
    elements.status.textContent = 'Backup is enabled. Waiting for the first sync…';
  } else {
    elements.status.textContent = state?.configured ? 'Backup is optional. Choose a privacy setting and continue.' : 'Cloud backup is unavailable in this build. You can start using SiteClock on this computer.';
  }
}
async function act(action) {
  if (busy || (action === 'signin-enable' && !elements.consent.checked)) return;
  busy = true; render();
  elements.status.textContent = action === 'signin-enable' ? 'Complete Google sign-in in the window that opens…' : 'Working…';
  try {
    state = await send(action);
    if (state.awaitingRecoveryAcknowledgement || state.awaitingMigrationConfirmation) {
      elements.newRecoveryCode.textContent = state.recoveryCode || '';
      elements.newRecoveryCode.hidden = !state.recoveryCode;
      elements.savedCodeLabel.hidden = !state.recoveryCode;
      elements.migrationConsentRow.hidden = !state.awaitingMigrationConfirmation;
      elements.recoveryHeading.textContent = state.recoveryCode ? 'Save your recovery code' : 'Confirm migration';
      elements.recoveryInstructions.textContent = state.awaitingMigrationConfirmation
        ? 'The existing account has plaintext cloud history. This migration first saves a local snapshot, then replaces the cloud records using your selected privacy setting. Keep this Chrome profile intact until the new backup finishes syncing.'
        : 'This code is the only way to unlock encrypted site names on another computer if this Chrome profile is unavailable. SiteClock cannot recover it.';
      elements.recoveryPanel.hidden = false;
      elements.status.textContent = state.recoveryCode ? 'Save this recovery code somewhere safe. Backup remains off until you confirm.' : 'Backup remains off until you confirm migration.';
      elements.browse.hidden = true;
    } else if (action === 'enable' && state.enabled) {
      elements.recoveryPanel.hidden = true;
      describe();
    } else if (action === 'cancel-migration') {
      elements.recoveryPanel.hidden = true;
      describe();
      elements.status.textContent = 'Migration cancelled. Existing hostnames remain unencrypted in cloud backup.';
    } else if (action === 'pause') {
      elements.status.textContent = 'You’re ready. Your time stays on this computer. You can enable backup in settings whenever you like.';
      elements.browse.hidden = false; elements.retry.hidden = true;
    } else describe();
  } catch (error) {
    elements.status.textContent = `${error.message} You can still use SiteClock on this computer.`;
    elements.browse.hidden = false;
  } finally { busy = false; render(); }
}
elements.local.addEventListener('click', () => act('pause'));
elements.consent.addEventListener('change', render);
elements.backup.addEventListener('click', () => act('signin-enable'));
elements.savedCode.addEventListener('change', render);
elements.migrationConsent.addEventListener('change', render);
elements.enableAfterRecovery.addEventListener('click', () => act('enable'));
elements.cancelMigration.addEventListener('click', () => act('cancel-migration'));
elements.retry.addEventListener('click', () => act('sync'));
elements.browse.addEventListener('click', () => chrome.tabs.update({ url: 'chrome://newtab/' }));
void send('status').then(value => { state = value; describe(); render(); }).catch(error => { elements.status.textContent = error.message; render(); });
setInterval(async () => {
  if (busy || !state?.enabled || (state.lastSync && !state.error)) return;
  try { state = await send('status'); describe(); render(); } catch { /* Keep the current actionable status. */ }
}, 5000);
