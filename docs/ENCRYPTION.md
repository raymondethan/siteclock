# Client-side encryption investigation

Status: hostname-only encryption and three cloud privacy modes are implemented in the 0.4.0 code, November 1, 2026. The development backend is deployed and synthetic Lambda/DynamoDB privacy checks pass. The implementation has received an internal code review; an independent cryptographic review and full production browser journey remain outstanding. Recovery-code encryption is the onboarding default, device-only encryption keeps its key in one Chrome profile, and plaintext backup is an explicit choice. Dates and durations remain readable in every mode. Existing plaintext history requires a local snapshot and explicit confirmation before cloud history is replaced.

## Goal and threat boundary

A database export, backup leak, or ordinary backend/developer access must not reveal website hostnames in newly encrypted data. The selected scope encrypts hostnames only. Dates and durations remain readable so existing aggregation and range queries can be retained. Google/Cognito authentication, authorization, HTTPS, and AWS encryption at rest remain necessary, but do not provide this property. AWS transparently decrypts ordinary table reads for authorized callers.

Call the resulting data encrypted or pseudonymous, not anonymous: account identity, installation IDs, record sizes, and upload timing can still reveal metadata. Local malware, a stolen unlocked browser profile, compromised extension code, or a malicious future extension update can access plaintext/key material on the client. E2EE does not eliminate these threats.

## Two viable scopes

### A. Encrypt website names and use secret keyed identifiers (selected)

Generate a random per-account key locally. Derive separate encryption and lookup keys with HKDF and explicit purpose labels. Replace hostnames in every DynamoDB key with HMAC-SHA-256 of the normalized hostname under the account's secret lookup key. Encrypt the hostname with authenticated AES-256-GCM, fresh unique 96-bit nonces, and authenticated account/key-version/record context. The actual key is never available to Lambda or stored unwrapped server-side.

Plain SHA-256(hostname), including a hash with a public per-account salt, is insufficient: the input vocabulary is guessable by hashing likely websites. A secret HMAC key prevents this database-only dictionary attack. Distinct account keys prevent matching the same site across accounts by its identifier. Equality of identifiers within an account still leaks repeated usage of that opaque site.

Durations and calendar dates can remain readable, which preserves the current monotonic-counter comparisons, transactional daily/lifetime deltas, and range queries. This protects names, not all browsing patterns. It must not be marketed as encrypted usage history in its entirety.

### B. Encrypt full usage payloads (not selected)

Encrypt hostname, dates, and durations before any upload, and decrypt/combine data only in the extension. The backend stores opaque identifiers, ciphertext envelopes, sizes, format/key versions, and ordering metadata; it never receives plaintext usage or decryption keys.

Current `max(totalMs)` comparisons and delta-based lifetime-summary calculations cannot operate on ciphertext. They must be replaced by client-produced summaries and a reviewed synchronization protocol. The server can still enforce identity, ownership, deletion generations, bounded ciphertext sizes, quotas, and conditional ordering/revision checks.

A candidate design uses versioned snapshots owned by each installation, with bounded encrypted shards and a commit manifest so incomplete uploads are never treated as complete. Each snapshot contains the local lifetime summary and its corresponding daily data from one accounting checkpoint. Other installations decrypt and combine contributions without uploading those remote contributions. Conditional commit/revision rules make retries idempotent and reject stale writes. Choose shard granularity and incremental download behavior before implementation; replacing everything with an unbounded JSON blob would create item-size and bandwidth problems.

Do not claim that AES or authenticated encryption alone prevents deletion, replay of old valid ciphertext, rollback after a browser crash, or malicious server omission. These require explicit version/checkpoint and recovery rules. Bind format, account, generation, installation, key version, and opaque record identity into authenticated context, and verify payload fields after decryption.

## Unlock and recovery

Google sign-in establishes account identity. Neither account ID, email address, nor access/refresh tokens are an acceptable encryption secret. If the server can return an unwrapped key to anyone who signs in, a server/developer with equivalent access can obtain it as well.

Options:

- **Random recovery code (implemented):** generate a random 256-bit account secret in the extension. HKDF derives distinct AES-GCM and HMAC keys. The code itself is the recovery secret; it is not sent to the server. An account-scoped HMAC fingerprint, encoded as a UUID, is the public key ID. A new profile verifies this fingerprint before persisting a recovery code or uploading usage; a mistyped code is rejected even when the account has no rows. The extension asks the user to confirm saving the code before backup starts. On a new installation, sign in and enter the code. If the code and all unlocked installations are lost, encrypted hostnames are unrecoverable.
- **Device-only key (implemented):** generate a random secret and keep it in the trusted extension storage for that Chrome profile. Another computer cannot unlock it. It can only merge site names available to that profile; site totals from other installations are intentionally unavailable in this mode.
- **Plaintext (implemented):** retain cross-installation aggregation while allowing the service and database operators to read hostnames.
- **Separate backup passphrase:** familiar but vulnerable to offline guessing after a database leak. Derive a wrapping key with a reviewed, salted password KDF such as Argon2id; keep the passphrase client-side. A passphrase change should rewrap a random data key rather than reencrypt every record. Benchmark and version KDF settings; do not invent a password-based encryption scheme.
- **Passkey PRF:** potentially better unlock UX. The WebAuthn PRF extension is expressly designed to support client-side encryption keys. A SiteClock passkey could wrap the account key and use the user's authenticator to unlock it. This is separate from the Google sign-in credential; it is not automatically supplied by Google OAuth. Verify PRF support, synced-credential behavior across actual devices/password managers, extension RP-ID/origin handling, and fallback recovery before relying on it. Keep a recovery option for unsupported authenticators or lost passkeys.
- **Approval from an existing installation:** possible later, using a reviewed authenticated key-transfer protocol with a user-verified pairing step. Do not send the key as an ordinary server-visible message or invent ad hoc exchange crypto.

If all unlocked installations and every recovery method are lost, we cannot recover old encrypted usage. The user can still recover/sign into the account and start fresh, but that is not recovery of the old data. A server-side support reset must not pretend otherwise.

The recovery code and device-local key are stored by the extension in trusted Chrome storage. This protects database exports and routine backend access, but not an unlocked browser profile, malware, or a malicious extension update. The server locks each account to a selected mode. The mode can only change after cloud history is cleared or migrated.

## Migration and release gate

The migration code aggregates lifetime and daily contributions into a local snapshot, asks for confirmation, atomically activates the target privacy mode and advances the account generation to retire the old rows, and rebuilds usage using the selected privacy mode. Verify exact totals and recovery after migration. A crash after generation advancement must recover from the local ledger/snapshot before the user clears profile data.

Block legacy plaintext writers after migration. Cover raw names in request URLs, keys, logs, pagination cursors, diagnostic messages, fixtures, and exported packages. Previous backups or retired plaintext records need separate retention/deletion treatment; a migration cannot retroactively make historical copies confidential. DynamoDB documentation also notes that some sort-key range boundaries can be plaintext in internal table metadata, reinforcing the use of opaque keys from the start.

Before launch: review the crypto protocol independently, exercise multi-installation unlock and key recovery, cancellation/locked state, wrong keys and tampered ciphertext, nonce handling across restarts, replay/out-of-order uploads, account switching, deletion/key rotation, partial migrations, and backup restore. Update onboarding and the public privacy claims only after these behaviors exist and are verified.

## Sources

- [AWS: client-side versus server-side encryption](https://docs.aws.amazon.com/database-encryption-sdk/latest/devguide/client-server-side.html)
- [AWS: DynamoDB encryption and sort-key metadata](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/EncryptionAtRest.html)
- [W3C Web Cryptography API](https://www.w3.org/TR/webcrypto/)
- [AES-GCM nonce and authenticated-data parameters](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams)
- [OWASP cryptographic storage and key wrapping](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
- [OWASP password KDF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [W3C WebAuthn PRF extension](https://www.w3.org/TR/webauthn-3/#prf-extension)
- [WebAuthn in extensions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Use_the_web_authn_api)
- [OWASP browser storage limitations](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html)
