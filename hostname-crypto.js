/* Browser-only hostname encryption primitives. No network, persistence or key escrow. */
globalThis.SiteClockHostnameCrypto = (() => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  function decode(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error('Invalid encrypted hostname format.');
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
    if (encode(bytes) !== value) throw Error('Invalid encrypted hostname format.');
    return bytes;
  }
  function normalize(hostname) {
    if (typeof hostname !== 'string' || hostname.length > 253 || !/^[a-z0-9.[\]:-]+$/.test(hostname)) throw Error('Invalid hostname.');
    const url = new URL(`https://${hostname}/`);
    if (url.hostname !== hostname || hostname.startsWith('www.')) throw Error('Hostname must be normalized.');
    return hostname;
  }
  function validateScope(scope) {
    for (const field of ['accountId', 'generation', 'keyId']) {
      if (typeof scope?.[field] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scope[field])) throw Error('Invalid encryption context.');
    }
  }
  function generateSecret() { return encode(crypto.getRandomValues(new Uint8Array(32))); }
  async function derive(secret, accountId) {
    if (typeof accountId !== 'string' || !accountId) throw Error('Invalid account context.');
    const bytes = decode(secret);
    if (bytes.length !== 32) throw Error('Invalid encryption key.');
    const material = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
    const parameters = label => ({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(accountId), info: encoder.encode(`SiteClock/hostname/v1/${label}`) });
    const [encryption, lookup] = await Promise.all([
      crypto.subtle.deriveKey(parameters('encryption'), material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
      crypto.subtle.deriveKey(parameters('lookup'), material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
    ]);
    // A public, account-scoped key fingerprint detects a mistyped recovery
    // code before any usage is uploaded. The secret has 256 random bits.
    const fingerprint = new Uint8Array(await crypto.subtle.sign('HMAC', lookup, encoder.encode('SiteClock/recovery-key-id/v1'))).slice(0, 16);
    fingerprint[6] = (fingerprint[6] & 15) | 64;
    fingerprint[8] = (fingerprint[8] & 63) | 128;
    const hex = [...fingerprint].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const keyId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return { keyNamespace: accountId, encryption, lookup, keyId };
  }
  async function domainId(keys, hostname) {
    return encode(new Uint8Array(await crypto.subtle.sign('HMAC', keys.lookup, encoder.encode(normalize(hostname)))));
  }
  const namespace = scope => scope.keyNamespace || scope.accountId;
  const context = (scope, id) => encoder.encode(JSON.stringify(['SiteClock/hostname', 1, scope.accountId, scope.generation, scope.keyId, scope.installationId || null, id]));
  async function encrypt(keys, hostname, scope) {
    validateScope(scope);
    if (keys.keyNamespace !== namespace(scope)) throw Error('Encryption account did not match.');
    const id = await domainId(keys, hostname);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context(scope, id), tagLength: 128 }, keys.encryption, encoder.encode(hostname));
    return { domainId: id, encryptedHostname: { version: 1, keyId: scope.keyId, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) } };
  }
  async function decrypt(keys, record, scope) {
    validateScope(scope);
    const envelope = record?.encryptedHostname;
    if (keys.keyNamespace !== namespace(scope) || envelope?.version !== 1 || envelope.keyId !== scope.keyId ||
        typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 400 || decode(record.domainId).length !== 32) throw Error('Invalid encrypted hostname.');
    const iv = decode(envelope.iv);
    const ciphertext = decode(envelope.ciphertext);
    if (iv.length !== 12 || ciphertext.length < 17) throw Error('Invalid encrypted hostname.');
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: context(scope, record.domainId), tagLength: 128 }, keys.encryption, ciphertext);
    const hostname = normalize(decoder.decode(plaintext));
    if (await domainId(keys, hostname) !== record.domainId) throw Error('Hostname identifier did not match.');
    return hostname;
  }
  return { generateSecret, derive, domainId, encrypt, decrypt };
})();
