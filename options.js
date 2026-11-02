const ids = ['account', 'authState', 'encryptionStatus', 'signin', 'signout', 'backupIntro', 'backupSetup', 'backupActive', 'backupChoices', 'keyOptions', 'recoveryInputRow', 'recoveryCode', 'backupConsent', 'enableBackup', 'backupToggle', 'privacyMode', 'status', 'retry', 'delete', 'backfillPanel', 'backfillSummary', 'backfillSource', 'backfill', 'recoveryPanel', 'recoveryHeading', 'recoveryInstructions', 'newRecoveryCode', 'savedCodeLabel', 'savedCode', 'migrationConsentRow', 'migrationConsent', 'confirmRecoveryCode'];
const elements = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
let busy = false;
let statusRequest;
let backfillSignature = '';
let currentState;
let authAttempt = 'idle';
let accountStatusUnavailable = false;
let authFailureMessage = '';
let pendingRecoveryCode = '';
let pendingBackupMode = 'recovery';
let awaitingMigration = false;

function setAuthState(kind, message) {
  elements.authState.className = `auth-state ${kind}`;
  elements.authState.textContent = message;
}
function selectedBackupMode() {
  return document.querySelector('input[name="backupMode"]:checked')?.value || 'recovery';
}
function selectedKeyAction() {
  return document.querySelector('input[name="keyAction"]:checked')?.value || 'generate';
}
function updateSetupControls() {
  const encrypted = selectedBackupMode() === 'recovery';
  const useExisting = encrypted && selectedKeyAction() === 'use';
  elements.keyOptions.hidden = !encrypted;
  elements.recoveryInputRow.hidden = !useExisting;
  elements.recoveryCode.disabled = busy;
  elements.backupConsent.disabled = busy;
  elements.enableBackup.disabled = busy || !elements.backupConsent.checked || (useExisting && !elements.recoveryCode.value.trim());
  elements.enableBackup.textContent = encrypted ? 'Continue with encrypted backup' : 'Continue with unencrypted backup';
  for (const choice of document.querySelectorAll('input[name="backupMode"], input[name="keyAction"]')) choice.disabled = busy;
}
function updateRecoveryConfirm() {
  elements.savedCode.disabled = busy;
  elements.migrationConsent.disabled = busy;
  elements.confirmRecoveryCode.disabled = busy || (!elements.savedCodeLabel.hidden && !elements.savedCode.checked) ||
    (!elements.migrationConsentRow.hidden && !elements.migrationConsent.checked);
}
function renderBackfills(state) {
  const sources = state.backfillSources || [];
  const signature = JSON.stringify(sources);
  if (signature !== backfillSignature) {
    const selected = elements.backfillSource.value;
    elements.backfillSource.replaceChildren();
    for (const source of sources) {
      const option = document.createElement('option');
      option.value = source.sourceAccountId;
      option.textContent = `${source.email} — ${source.siteCount} sites, ${(source.totalMs / 3_600_000).toFixed(1)} hours`;
      elements.backfillSource.append(option);
    }
    if (sources.some(source => source.sourceAccountId === selected)) elements.backfillSource.value = selected;
    backfillSignature = signature;
  }
  elements.backfillPanel.hidden = !sources.length;
  elements.backfillSummary.textContent = sources.length === 1
    ? `Found older website totals for ${sources[0].email} on this Chrome profile. Import them into the production account; the source copy stays here.`
    : `Found ${sources.length} previous account histories for ${state.email}. Choose which one to add to this account.`;
  elements.backfillSource.disabled = busy || !sources.length;
  elements.backfill.disabled = busy || !state.enabled || !sources.length;
}
function render(state) {
  currentState = state;
  accountStatusUnavailable = false;
  if (!state.signedIn) {
    for (const mode of document.querySelectorAll('input[name="backupMode"]')) mode.checked = mode.value === 'recovery';
    for (const choice of document.querySelectorAll('input[name="keyAction"]')) choice.checked = choice.value === 'generate';
    elements.backupConsent.checked = false;
    elements.recoveryCode.value = '';
    elements.recoveryPanel.hidden = true;
    pendingRecoveryCode = '';
  }
  elements.account.textContent = state.signedIn ? `Google account: ${state.email || 'connected'}` : 'No Google account connected';
  const needsReconnect = state.error === 'Sign in again to resume backup.';
  if (authAttempt === 'failed') {
    setAuthState('failed', `Google sign-in failed${authFailureMessage ? `: ${authFailureMessage}` : ''}. Your local history is unchanged; try again or continue without backup.`);
  } else if (needsReconnect) {
    authAttempt = 'expired';
    setAuthState('expired', 'Reconnect required. SiteClock cannot use the saved Google session to resume backup. Your local history is unchanged.');
  } else if (state.signedIn) {
    authAttempt = 'success';
    authFailureMessage = '';
    setAuthState('success', `Google sign-in successful${state.email ? ` — connected as ${state.email}` : '.'}`);
  } else {
    authAttempt = 'idle';
    setAuthState('idle', 'Not signed in. Sign in with Google to set up cloud backup. Your history stays on this computer until you opt in.');
  }
  elements.signin.hidden = false;
  elements.signin.textContent = authAttempt === 'failed' ? 'Try Google sign-in again' : authAttempt === 'expired' ? 'Reconnect Google account' : state.signedIn ? 'Switch Google account' : 'Sign in with Google';
  elements.signin.disabled = busy || !state.configured;
  elements.signout.hidden = !state.signedIn;
  elements.signout.disabled = busy;
  elements.encryptionStatus.hidden = !state.signedIn;
  elements.encryptionStatus.className = `encryption-status ${state.privacyMode === 'unencrypted' ? 'unencrypted' : state.privacyMode ? 'encrypted' : 'unset'}`;
  elements.encryptionStatus.textContent = !state.signedIn ? '' : state.privacyMode === 'unencrypted'
    ? 'Website-name encryption: OFF — cloud backup stores readable hostnames.'
    : state.privacyMode === 'device'
      ? 'Website-name encryption: ON — encrypted for this Chrome profile.'
      : state.privacyMode === 'recovery'
        ? 'Website-name encryption: ON — encrypted with your recovery key.'
        : 'Website-name encryption: NOT SET UP — no cloud backup data has been selected.';
  elements.backupIntro.textContent = state.privacyMode === 'device'
    ? 'This account uses encryption tied to this Chrome profile. Its site names cannot be combined across computers.'
    : 'Sign in to choose encrypted backup or unencrypted backup. Encrypted backup is selected by default.';
  const configuredPrivacy = Boolean(state.privacyMode);
  elements.backupSetup.hidden = !state.signedIn || configuredPrivacy || state.enabled;
  elements.backupActive.hidden = !state.signedIn || !configuredPrivacy;
  if (configuredPrivacy) {
    elements.privacyMode.textContent = `Current protection: ${state.privacyMode === 'recovery' ? 'encrypted with a recovery key' : state.privacyMode === 'device' ? 'encrypted for this Chrome profile' : 'unencrypted'}.`;
    elements.backupToggle.textContent = state.enabled ? 'Pause cloud backup' : 'Resume cloud backup';
    elements.backupToggle.disabled = busy;
  }
  elements.backupChoices.disabled = busy;
  elements.delete.disabled = busy || !state.signedIn;
  elements.retry.hidden = !state.enabled;
  elements.retry.disabled = busy;
  renderBackfills(state);
  const environment = state.environment === 'development' ? 'Development service.' : state.environment === 'production' ? 'Production service.' : '';
  const serviceStatus = !state.configured ? 'Cloud backup is not configured in this build.' :
    state.error || (state.syncing ? 'Syncing…' : state.enabled ? `Backup on. ${state.lastSync ? `Last synced ${new Date(state.lastSync).toLocaleString()}.` : 'Waiting for first sync.'}` :
      state.signedIn ? 'Signed in. Cloud backup has not started.' : 'Local tracking is ready; cloud backup has not started.');
  elements.status.textContent = [environment, serviceStatus].filter(Boolean).join(' ');
  updateSetupControls();
  updateRecoveryConfirm();
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
      const needsReconnect = error.message === 'Sign in again to resume backup.';
      accountStatusUnavailable = !needsReconnect;
      elements.account.textContent = needsReconnect ? 'Google session needs reconnection' : 'Google account status is unavailable';
      if (needsReconnect) {
        authAttempt = 'expired';
        setAuthState('expired', 'Reconnect required. Your local history is safe; cloud backup will resume after sign-in.');
        elements.status.textContent = 'Cloud backup is paused until you reconnect.';
      } else {
        setAuthState('unknown', `We couldn’t check sign-in status (${error.message}). This does not mean Google sign-in failed.`);
        elements.status.textContent = error.message;
      }
      elements.signin.hidden = false;
      elements.signin.textContent = needsReconnect ? 'Reconnect Google account' : 'Retry account check';
      elements.signin.disabled = busy || currentState?.configured === false;
      elements.backupToggle.disabled = true;
      elements.delete.disabled = true;
      elements.backfill.disabled = true;
      throw error;
    } finally {
      clearTimeout(timeout);
      statusRequest = null;
    }
  })();
  return statusRequest;
}
function showRecoveryStep(result, mode) {
  pendingBackupMode = mode;
  pendingRecoveryCode = result.recoveryCode || '';
  awaitingMigration = Boolean(result.awaitingMigrationConfirmation);
  elements.newRecoveryCode.textContent = pendingRecoveryCode;
  elements.newRecoveryCode.hidden = !pendingRecoveryCode;
  elements.savedCodeLabel.hidden = !pendingRecoveryCode;
  elements.savedCode.checked = false;
  elements.migrationConsentRow.hidden = !awaitingMigration;
  elements.migrationConsent.checked = false;
  elements.recoveryHeading.textContent = pendingRecoveryCode ? 'Save your recovery key' : 'Confirm cloud-history migration';
  elements.recoveryInstructions.textContent = awaitingMigration
    ? 'This account has older cloud history. SiteClock will save a local migration snapshot before replacing it with the selected backup protection.'
    : 'This key unlocks encrypted website names on your other computers. SiteClock cannot recover it if it is lost.';
  elements.recoveryPanel.hidden = false;
  updateRecoveryConfirm();
}
async function act(action, extra = {}) {
  if (busy) return;
  busy = true;
  for (const element of Object.values(elements)) if (element?.matches?.('button, input, select')) element.disabled = true;
  if (action === 'signin') {
    authAttempt = 'pending';
    authFailureMessage = '';
    elements.signin.hidden = false;
    elements.signin.textContent = 'Google sign-in pending…';
    setAuthState('pending', 'Google sign-in is in progress. Complete the step in the Google window.');
  }
  elements.status.textContent = action === 'signin' ? 'Complete Google sign-in in the window that opens…' : 'Working…';
  let timeout;
  try {
    const result = await Promise.race([
      chrome.runtime.sendMessage({ type: `siteclock:cloud:${action}`, ...extra }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(Error(action === 'signin'
        ? 'Sign-in is taking too long. Check for a Google sign-in window, then try again. Local tracking continues.'
        : 'SiteClock is taking too long to respond. Local tracking continues.')), 120_000); })
    ]);
    if (!result || result.error) throw Error(result?.error || 'SiteClock is reconnecting. Reload this settings page.');
    busy = false;
    render(result);
    if (result.awaitingRecoveryAcknowledgement || result.awaitingMigrationConfirmation) showRecoveryStep(result, extra.privacyMode || result.privacyMode || pendingBackupMode);
    else if (action === 'enable' && result.enabled) {
      elements.recoveryPanel.hidden = true;
      pendingRecoveryCode = '';
      elements.status.textContent = `Backup is on with ${result.privacyMode === 'unencrypted' ? 'unencrypted' : 'encrypted'} website names.`;
    } else if (action === 'backfill' && result.backfilled) {
      const { siteCount, totalMs } = result.backfilled;
      elements.status.textContent = `Imported and synced ${siteCount} sites (${(totalMs / 3_600_000).toFixed(1)} hours) to the production account.`;
    }
  } catch (error) {
    busy = false;
    if (action === 'signin') { authAttempt = 'failed'; authFailureMessage = error.message; }
    await status().catch(() => {});
    if (action === 'signin') {
      authAttempt = 'failed';
      authFailureMessage = error.message;
      elements.signin.hidden = false;
      elements.signin.textContent = 'Try Google sign-in again';
      setAuthState('failed', `Google sign-in failed: ${error.message}. Your local history is unchanged.`);
    }
    elements.status.textContent = action === 'signin' ? 'Cloud backup was not changed.' : error.message;
  } finally {
    clearTimeout(timeout);
    busy = false;
    updateSetupControls();
    updateRecoveryConfirm();
  }
}

elements.signin.addEventListener('click', () => {
  if (accountStatusUnavailable) {
    setAuthState('pending', 'Checking your Google account status…');
    void status().catch(() => {});
  } else void act('signin');
});
elements.signout.addEventListener('click', () => act('signout'));
elements.backupConsent.addEventListener('change', updateSetupControls);
elements.recoveryCode.addEventListener('input', updateSetupControls);
for (const choice of document.querySelectorAll('input[name="backupMode"], input[name="keyAction"]')) choice.addEventListener('change', updateSetupControls);
elements.enableBackup.addEventListener('click', () => {
  if (!elements.backupConsent.checked) return;
  const mode = selectedBackupMode();
  pendingBackupMode = mode;
  const recoveryCode = mode === 'recovery' && selectedKeyAction() === 'use' ? elements.recoveryCode.value.trim() : undefined;
  if (mode === 'recovery' && selectedKeyAction() === 'use' && !recoveryCode) return;
  if (mode === 'unencrypted' && !confirm('Continue with unencrypted backup? Website names will be readable by the service and its operators.')) return;
  void act('enable', { privacyMode: mode, ...(recoveryCode ? { recoveryCode } : {}), ...(mode === 'recovery' && !recoveryCode ? { generateRecoveryCode: true } : {}) });
});
elements.confirmRecoveryCode.addEventListener('click', () => {
  if (!elements.savedCodeLabel.hidden && !elements.savedCode.checked) return;
  if (!elements.migrationConsentRow.hidden && !elements.migrationConsent.checked) return;
  void act('enable', { privacyMode: pendingBackupMode, recoveryCode: pendingRecoveryCode || elements.recoveryCode.value.trim(),
    savedRecoveryCode: elements.savedCode.checked, confirmMigration: elements.migrationConsent.checked });
});
elements.savedCode.addEventListener('change', updateRecoveryConfirm);
elements.migrationConsent.addEventListener('change', updateRecoveryConfirm);
elements.backupToggle.addEventListener('click', () => act(currentState?.enabled ? 'pause' : 'enable', {
  ...(currentState?.privacyMode ? { privacyMode: currentState.privacyMode } : {})
}));
elements.retry.addEventListener('click', () => act('retry'));
elements.backfill.addEventListener('click', () => {
  const source = (currentState?.backfillSources || []).find(item => item.sourceAccountId === elements.backfillSource.value);
  if (!source) return;
  const hours = (source.totalMs / 3_600_000).toFixed(1);
  if (confirm(`Import ${source.siteCount} sites (${hours} hours) from ${source.email} into this production account? The old account copy stays on this computer. Imported names will be encrypted with this account’s privacy setting before syncing.`)) {
    void act('backfill', { sourceAccountId: source.sourceAccountId });
  }
});
elements.delete.addEventListener('click', () => {
  if (confirm('Delete cloud history across ALL installations? Backup will pause. Existing local contributions stay local and will not automatically upload again. Disaster-recovery copies expire within seven days.')) void act('delete');
});
void status().catch(() => {});
setInterval(() => { if (!busy) void status().catch(() => {}); }, 5000);
