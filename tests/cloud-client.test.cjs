const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, '../cloud-client.js'), 'utf8');
const accountId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const config = { apiBase: 'https://abc.execute-api.us-east-1.amazonaws.com', authBase: 'https://siteclock.auth.us-east-1.amazoncognito.com', clientId: 'client', userPoolId: 'us-east-1_pool' };
function client(override) {
  const local = {}, session = {}, calls = [];
  const storage = data => ({ async get(key) { return structuredClone({ [key]: data[key] }); }, async set(values) { Object.assign(data, structuredClone(values)); }, async remove(key) { delete data[key]; } });
  let authURL;
  const env = { local, session, calls, delayRefresh: null, invalidState: false, canceled: false };
  const context = vm.createContext({ SiteClockCloudConfig: override || config, URL, URLSearchParams, AbortSignal, TextEncoder, Uint8Array,
    crypto: webcrypto, btoa, Date, chrome: { storage: { local: storage(local), session: storage(session) }, identity: {
      getRedirectURL: path => `https://extension.chromiumapp.org/${path}`,
      async launchWebAuthFlow({ url }) {
        authURL = new URL(url);
        if (env.canceled) throw Error('User canceled.');
        return `${authURL.searchParams.get('redirect_uri')}?state=${env.invalidState ? 'invalid' : authURL.searchParams.get('state')}&code=code`;
      }
    } }, async fetch(url, options = {}) {
      calls.push({ url, options });
      let result;
      if (url.endsWith('/oauth2/token')) {
        const body = new URLSearchParams(options.body);
        if (body.get('grant_type') === 'authorization_code') {
          const expected = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')))).toString('base64url');
          assert.equal(expected, authURL.searchParams.get('code_challenge'));
        } else if (env.delayRefresh) await env.delayRefresh;
        result = { access_token: 'access', refresh_token: 'refresh-new', expires_in: 3600 };
      } else if (url.endsWith('/v1/account')) result = { accountId, generation: 'generation' };
      else if (url.endsWith('/oauth2/userInfo')) result = { sub: accountId, email: 'person@example.test' };
      else result = { ok: true };
      return { ok: true, async json() { return result; } };
    }
  });
  vm.runInContext(source, context);
  env.client = context.SiteClockCloud;
  env.authURL = () => authURL;
  return env;
}
test('unconfigured build refuses network sign-in and sync', async () => {
  const e = client({});
  await assert.rejects(e.client.signIn(), /not configured/);
  await assert.rejects(e.client.api('/v1/account'), /not configured/);
  assert.equal(e.calls.length, 0);
});
test('Google sign-in verifies PKCE, state, identity and uses only basic identity scopes', async () => {
  const e = client(); const result = await e.client.signIn();
  assert.equal(result.email, 'person@example.test');
  assert.equal(e.local.siteclockAuth.accountId, accountId);
  assert.equal(e.authURL().searchParams.get('identity_provider'), 'Google');
  assert.equal(e.authURL().searchParams.get('prompt'), 'select_account');
  assert.equal(e.authURL().searchParams.get('scope'), 'openid email');
  assert.equal(e.authURL().searchParams.get('response_type'), 'code');
  assert.equal(e.authURL().searchParams.has('client_secret'), false);
  assert.equal(e.session.siteclockOAuth, undefined);
});
test('canceled and invalid-state sign-in leave no credentials or pending PKCE secrets', async () => {
  for (const mode of ['canceled', 'invalidState']) {
    const e = client(); e[mode] = true;
    await assert.rejects(e.client.signIn());
    assert.equal(e.local.siteclockAuth, undefined);
    assert.equal(e.session.siteclockOAuth, undefined);
    assert.equal(e.calls.length, 0);
  }
});
test('API refuses to upload counters using another account’s credentials', async () => {
  const e = client(); await e.client.signIn(); const before = e.calls.length;
  await assert.rejects(e.client.api('/v1/usage', 'PUT', { counters: [] }, otherId), error => error.status === 401);
  assert.equal(e.calls.length, before);
});
test('concurrent token refresh is deduplicated and rotated token is saved', async () => {
  const e = client(); await e.client.signIn(); e.local.siteclockAuth.expiresAt = 0;
  await Promise.all([e.client.api('/v1/account', 'GET', undefined, accountId), e.client.api('/v1/account', 'GET', undefined, accountId)]);
  const tokenCalls = e.calls.filter(call => call.url.endsWith('/oauth2/token'));
  assert.equal(tokenCalls.length, 2); // one initial code exchange, one shared refresh
  assert.equal(e.local.siteclockAuth.refreshToken, 'refresh-new');
});
test('sign-out during refresh cannot restore deleted credentials', async () => {
  const e = client(); await e.client.signIn(); e.local.siteclockAuth.expiresAt = 0;
  let release; e.delayRefresh = new Promise(resolve => { release = resolve; });
  const request = e.client.api('/v1/account', 'GET', undefined, accountId);
  while (!e.calls.some(call => call.url.endsWith('/oauth2/token') && new URLSearchParams(call.options.body).get('grant_type') === 'refresh_token')) await new Promise(resolve => setImmediate(resolve));
  await e.client.signOut(); release();
  await assert.rejects(request, error => error.status === 401);
  assert.equal(e.local.siteclockAuth, null);
});
