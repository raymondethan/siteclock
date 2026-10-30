/* Runs only in the trusted background worker. Never sends credentials to content scripts. */
globalThis.SiteClockCloud = (() => {
  const config = SiteClockCloudConfig;
  const configured = Boolean(config.apiBase && config.authBase && config.clientId && config.userPoolId);
  const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  let refreshing;
  class CloudError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }
  async function request(url, options) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000), cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new CloudError(data.message || 'Cloud request failed. Please retry.', response.status);
    return data;
  }
  async function tokenRequest(values) {
    return request(`${config.authBase}/oauth2/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, ...values }).toString()
    });
  }
  const expires = result => ({ accessToken: result.access_token, refreshToken: result.refresh_token,
    expiresAt: Date.now() + result.expires_in * 1000 });
  async function credentials() { return (await chrome.storage.local.get('siteclockAuth')).siteclockAuth; }
  async function saveAuth(value) { await chrome.storage.local.set({ siteclockAuth: value }); }
  async function accessToken(expectedAccount) {
    const current = await credentials();
    if (!current || (expectedAccount && current.accountId !== expectedAccount)) throw new CloudError('Sign in again to resume backup.', 401);
    if (current.expiresAt > Date.now() + 60_000) return current.accessToken;
    if (!refreshing) refreshing = (async () => {
      let result;
      try { result = await tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refreshToken }); }
      catch (error) {
        if (error.status === 400) throw new CloudError('Sign in again to resume backup.', 401);
        throw error;
      }
      // A sign-out or account switch must win over an in-flight refresh.
      const latest = await credentials();
      if (latest?.refreshToken !== current.refreshToken) throw new CloudError('Account changed.', 401);
      const next = { ...current, ...expires(result), refreshToken: result.refresh_token || current.refreshToken };
      await saveAuth(next);
      return next.accessToken;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function api(path, method = 'GET', body, expectedAccount) {
    if (!configured) throw Error('Cloud backup is not configured in this build.');
    return request(`${config.apiBase}${path}`, { method,
      headers: { Authorization: `Bearer ${await accessToken(expectedAccount)}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function signIn() {
    if (!configured) throw Error('Cloud backup is not configured in this build.');
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const redirect = chrome.identity.getRedirectURL('oauth2');
    const url = new URL(`${config.authBase}/oauth2/authorize`);
    url.search = new URLSearchParams({ client_id: config.clientId, response_type: 'code', redirect_uri: redirect,
      scope: 'openid email', identity_provider: 'Google', state, code_challenge: challenge, code_challenge_method: 'S256' });
    // Persist PKCE state in storage.session: MV3 can recreate the worker during interactive login.
    await chrome.storage.session.set({ siteclockOAuth: { verifier, state, redirect } });
    try {
      const result = new URL(await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true }));
      const pending = (await chrome.storage.session.get('siteclockOAuth')).siteclockOAuth;
      if (!pending || result.origin + result.pathname !== redirect || result.searchParams.get('state') !== pending.state || !result.searchParams.get('code')) {
        throw Error('Sign-in response could not be verified.');
      }
      const tokens = await tokenRequest({ grant_type: 'authorization_code', code: result.searchParams.get('code'),
        redirect_uri: pending.redirect, code_verifier: pending.verifier });
      const auth = expires(tokens);
      // The backend verifies the token and supplies the authoritative account ID.
      const account = await request(`${config.apiBase}/v1/account`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` }
      });
      const identity = await request(`${config.authBase}/oauth2/userInfo`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` }
      });
      if (identity.sub !== account.accountId) throw Error('Account identity did not match.');
      account.email = identity.email || 'Google account';
      await saveAuth({ ...auth, accountId: account.accountId });
      return account;
    } finally { await chrome.storage.session.remove('siteclockOAuth'); }
  }
  async function signOut() {
    const previous = await credentials();
    await saveAuth(null);
    if (previous?.refreshToken) {
      try {
        await request(`${config.authBase}/oauth2/revoke`, { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: config.clientId, token: previous.refreshToken }).toString() });
      } catch { /* Local sign-out succeeds even without a connection. */ }
    }
  }
  return { configured, api, signIn, signOut };
})();
