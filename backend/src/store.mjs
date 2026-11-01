import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, BatchWriteCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { HttpError } from './service.mjs';
const accountPK = id => `ACCOUNT#${id}`;
const usagePK = (id, generation) => `${accountPK(id)}#${generation}`;
export class Store {
  constructor(client, table, limits = {}) { this.client = client; this.table = table; this.limits = limits; }
  send(Command, input) { return this.client.send(new Command({ TableName: this.table, ...input })); }
  async account(id) {
    const Key = { pk: accountPK(id), sk: 'PROFILE' };
    const { Item } = await this.send(GetCommand, { Key, ConsistentRead: true });
    if (Item) return Item;
    const profile = { ...Key, generation: randomUUID(), createdAt: Date.now(), version: 1 };
    try { await this.send(PutCommand, { Item: profile, ConditionExpression: 'attribute_not_exists(pk)' }); return profile; }
    catch (error) { if (error.name !== 'ConditionalCheckFailedException') throw error; }
    return (await this.send(GetCommand, { Key, ConsistentRead: true })).Item;
  }
  async configurePrivacy(id, generation, privacyMode, keyId, pending = {}) {
    const Key = { pk: accountPK(id), sk: 'PROFILE' };
    let current = await this.account(id);
    if (current.generation !== generation) throw new HttpError(409, 'Cloud history changed.');
    if (privacyMode === 'migrating') {
      if (current.privacyMode === 'migrating') {
        if (current.pendingPrivacyMode === pending.targetMode && current.pendingKeyId === pending.targetKeyId &&
            current.pendingMigrationId === pending.migrationId && current.pendingMigrationInstallation === pending.installationId) return current;
        if (current.pendingPrivacyMode === pending.targetMode && current.pendingKeyId === pending.targetKeyId &&
            !current.pendingMigrationId && pending.migrationId && pending.installationId) {
          try { await this.send(UpdateCommand, { Key, UpdateExpression: 'SET pendingMigrationId = :id, pendingMigrationInstallation = :owner',
            ConditionExpression: 'generation = :g AND privacyMode = :migrating AND pendingPrivacyMode = :target AND attribute_not_exists(pendingMigrationId)',
            ExpressionAttributeValues: { ':g': generation, ':migrating': 'migrating', ':target': pending.targetMode,
              ':id': pending.migrationId, ':owner': pending.installationId } }); }
          catch (error) { if (error.name !== 'ConditionalCheckFailedException') throw error; }
          current = await this.account(id);
          if (current.pendingMigrationId === pending.migrationId && current.pendingMigrationInstallation === pending.installationId) return current;
        }
        throw new HttpError(409, 'Another privacy migration is already in progress.');
      }
      if (current.privacyMode && current.privacyMode !== 'unencrypted') throw new HttpError(409, 'This account already uses a different hostname privacy setting.');
      const values = { ':g': generation, ':migration': 'migrating', ':target': pending.targetMode };
      const fromMode = current.privacyMode === 'unencrypted';
      const condition = fromMode ? 'generation = :g AND privacyMode = :plain' : 'generation = :g AND attribute_not_exists(privacyMode)';
      if (fromMode) values[':plain'] = 'unencrypted';
      let expression = 'SET privacyMode = :migration, pendingPrivacyMode = :target REMOVE keyId';
      if (pending.targetKeyId) { values[':pendingKey'] = pending.targetKeyId; expression = 'SET privacyMode = :migration, pendingPrivacyMode = :target, pendingKeyId = :pendingKey REMOVE keyId'; }
      else expression += ', pendingKeyId';
      if (pending.migrationId) { values[':migrationId'] = pending.migrationId; expression = expression.replace(' REMOVE ', ', pendingMigrationId = :migrationId REMOVE '); }
      else expression += ', pendingMigrationId';
      if (pending.installationId) { values[':owner'] = pending.installationId; expression = expression.replace(' REMOVE ', ', pendingMigrationInstallation = :owner REMOVE '); }
      else expression += ', pendingMigrationInstallation';
      try { await this.send(UpdateCommand, { Key, UpdateExpression: expression, ConditionExpression: condition, ExpressionAttributeValues: values }); }
      catch (error) {
        if (error.name !== 'ConditionalCheckFailedException') throw error;
        const latest = await this.account(id);
        if (latest.privacyMode === 'migrating' && latest.pendingPrivacyMode === pending.targetMode && latest.pendingKeyId === pending.targetKeyId &&
            latest.pendingMigrationId === pending.migrationId && latest.pendingMigrationInstallation === pending.installationId) return latest;
        throw new HttpError(409, 'This account already uses a different hostname privacy setting.');
      }
      return this.account(id);
    }
    if (current.privacyMode === 'migrating') {
      if (privacyMode !== 'unencrypted') throw new HttpError(409, 'Finish or cancel the current privacy migration first.');
      try { await this.send(UpdateCommand, { Key, UpdateExpression: 'SET privacyMode = :plain REMOVE pendingPrivacyMode, pendingKeyId, pendingMigrationId, pendingMigrationInstallation',
        ConditionExpression: 'generation = :g AND privacyMode = :migration',
        ExpressionAttributeValues: { ':g': generation, ':plain': 'unencrypted', ':migration': 'migrating' } }); }
      catch (error) { if (error.name !== 'ConditionalCheckFailedException') throw error; }
      return this.account(id);
    }
    if (current.privacyMode === privacyMode) {
      if (privacyMode === 'recovery' && current.keyId !== keyId) throw new HttpError(409, 'This account already uses a different hostname privacy setting.');
      return current;
    }
    if (current.privacyMode && current.privacyMode !== 'unencrypted') throw new HttpError(409, 'This account already uses a different hostname privacy setting.');

    if (['recovery', 'device'].includes(privacyMode)) {
      // Lock the profile before checking for legacy rows. Every usage write
      // condition-checks the observed mode, so an in-flight plaintext request
      // either commits before this lock or fails after it.
      const locked = await this.configurePrivacy(id, generation, 'migrating', undefined,
        { targetMode: privacyMode, targetKeyId: privacyMode === 'recovery' ? keyId : undefined, migrationId: pending.migrationId,
          installationId: pending.installationId });
      const existing = await this.send(QueryCommand, { KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': usagePK(id, generation), ':prefix': 'USAGE#' }, Limit: 1, ConsistentRead: true });
      if (existing.Items?.length) throw new HttpError(409, 'This account has existing unencrypted cloud history. Confirm migration before enabling hostname encryption.');
      const values = { ':g': generation, ':migration': 'migrating', ':target': privacyMode };
      let expression = 'SET privacyMode = :target REMOVE pendingPrivacyMode, pendingKeyId, keyId';
      let condition = 'generation = :g AND privacyMode = :migration AND pendingPrivacyMode = :target';
      if (privacyMode === 'recovery') {
        values[':keyId'] = keyId; values[':pendingKey'] = keyId;
        expression = 'SET privacyMode = :target, keyId = :keyId REMOVE pendingPrivacyMode, pendingKeyId';
        condition += ' AND pendingKeyId = :pendingKey';
      } else condition += ' AND attribute_not_exists(pendingKeyId)';
      expression = expression.replace(' REMOVE ', ' REMOVE pendingMigrationId, ');
      expression = expression.replace(' REMOVE ', ' REMOVE pendingMigrationInstallation, ');
      if (pending.migrationId) { values[':migrationId'] = pending.migrationId; condition += ' AND pendingMigrationId = :migrationId'; }
      else condition += ' AND attribute_not_exists(pendingMigrationId)';
      await this.send(UpdateCommand, { Key, UpdateExpression: expression, ConditionExpression: condition, ExpressionAttributeValues: values });
      return this.account(id);
    }
    if (privacyMode !== 'unencrypted') throw new HttpError(400, 'Invalid hostname privacy setting.');
    if (current.privacyMode === 'unencrypted') return current;
    try { await this.send(UpdateCommand, { Key, UpdateExpression: 'SET privacyMode = :plain REMOVE keyId',
      ConditionExpression: 'generation = :g AND attribute_not_exists(privacyMode)',
      ExpressionAttributeValues: { ':g': generation, ':plain': 'unencrypted' } }); }
    catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      const latest = await this.account(id);
      if (latest.privacyMode === 'unencrypted') return latest;
      throw new HttpError(409, 'This account already uses a different hostname privacy setting.');
    }
    return this.account(id);
  }
  async hasUsage(id, generation) {
    const result = await this.send(QueryCommand, { KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': usagePK(id, generation), ':prefix': 'USAGE#' }, Limit: 1, ConsistentRead: true });
    return Boolean(result.Items?.length);
  }
  guard(id, generation, addedRows = 0, expectedPrivacyMode) {
    const privacyCondition = expectedPrivacyMode === undefined ? 'attribute_not_exists(privacyMode)' : 'privacyMode = :privacy';
    const privacyValues = expectedPrivacyMode === undefined ? {} : { ':privacy': expectedPrivacyMode };
    if (addedRows && this.limits.maxUsageRows) {
      return { Update: { TableName: this.table, Key: { pk: accountPK(id), sk: 'PROFILE' },
        UpdateExpression: 'SET usageRows = if_not_exists(usageRows, :zero) + :added',
        ConditionExpression: `generation = :g AND ${privacyCondition} AND (attribute_not_exists(usageRows) OR usageRows <= :remaining)`,
        ExpressionAttributeValues: { ':g': generation, ...privacyValues, ':zero': 0, ':added': addedRows, ':remaining': this.limits.maxUsageRows - addedRows } } };
    }
    return { ConditionCheck: { TableName: this.table, Key: { pk: accountPK(id), sk: 'PROFILE' },
      ConditionExpression: `generation = :g AND ${privacyCondition}`,
      ExpressionAttributeValues: { ':g': generation, ...privacyValues } } };
  }
  async transaction(items) { return this.client.send(new TransactWriteCommand({ TransactItems: items })); }
  async register(id, generation, installationId, expectedPrivacyMode) {
    const Key = { pk: usagePK(id, generation), sk: `INSTALL#${installationId}` };
    if (this.limits.maxInstallations) {
      const { Item } = await this.send(GetCommand, { Key, ConsistentRead: true });
      if (!Item) {
        try {
          await this.transaction([{ Update: { TableName: this.table, Key: { pk: accountPK(id), sk: 'PROFILE' },
            UpdateExpression: 'SET installationCount = if_not_exists(installationCount, :zero) + :one',
            ConditionExpression: `generation = :g AND ${expectedPrivacyMode === undefined ? 'attribute_not_exists(privacyMode)' : 'privacyMode = :privacy'} AND (attribute_not_exists(installationCount) OR installationCount < :max)`,
            ExpressionAttributeValues: { ':g': generation, ...(expectedPrivacyMode === undefined ? {} : { ':privacy': expectedPrivacyMode }), ':zero': 0, ':one': 1, ':max': this.limits.maxInstallations } } },
          { Put: { TableName: this.table, Item: { ...Key, createdAt: Date.now(), lastSyncAt: Date.now() }, ConditionExpression: 'attribute_not_exists(pk)' } }]);
          return;
        } catch (error) {
          if (error.name === 'TransactionCanceledException' && error.CancellationReasons?.[1]?.Code === 'ConditionalCheckFailed') {
            return this.register(id, generation, installationId, expectedPrivacyMode);
          }
          await this.rethrowQuota(id, generation, error, 'install');
          throw error;
        }
      }
    }
    try {
      await this.transaction([this.guard(id, generation, 0, expectedPrivacyMode), { Update: {
        TableName: this.table, Key: { pk: usagePK(id, generation), sk: `INSTALL#${installationId}` },
        UpdateExpression: 'SET createdAt = if_not_exists(createdAt, :now), lastSyncAt = :now',
        ExpressionAttributeValues: { ':now': Date.now() }
      } }]);
    } catch (error) { await this.rethrowGeneration(id, generation, error); }
  }
  async rethrowGeneration(id, generation, error) {
    if (error.name === 'TransactionCanceledException' && (await this.account(id)).generation !== generation) {
      throw new HttpError(409, 'Cloud history changed.');
    }
    throw error;
  }
  async upload(id, generation, installationId, row, expectedPrivacyMode) {
    const Key = { pk: usagePK(id, generation), sk: `USAGE#${installationId}#${row.hostname}` };
    const existing = this.limits.maxUsageRows ? (await this.send(GetCommand, { Key, ConsistentRead: true })).Item : null;
    try {
      await this.transaction([this.guard(id, generation, existing ? 0 : 1, expectedPrivacyMode), { Update: {
        TableName: this.table, Key,
        UpdateExpression: 'SET totalMs = :ms, updatedAt = :now, installationId = :id, hostname = :host',
        ConditionExpression: this.limits.maxUsageRows && !existing ? 'attribute_not_exists(pk)' : '(attribute_not_exists(totalMs) OR totalMs < :ms) AND attribute_not_exists(periodVersion)',
        ExpressionAttributeValues: { ':ms': row.totalMs, ':now': Date.now(), ':id': installationId, ':host': row.hostname }
      } }]);
    } catch (error) {
      if (error.name === 'TransactionCanceledException') {
        await this.rethrowQuota(id, generation, error);
        if ((await this.account(id)).generation !== generation) throw new HttpError(409, 'Cloud history changed.');
        if (error.CancellationReasons?.[1]?.Code === 'ConditionalCheckFailed') {
          const { Item } = await this.send(GetCommand, { Key: { pk: usagePK(id, generation), sk: `USAGE#${installationId}#${row.hostname}` }, ConsistentRead: true });
          if (Item?.periodVersion === 2) throw new HttpError(426, 'Update SiteClock to sync daily usage.');
          if (Item && Item.totalMs < row.totalMs) return this.upload(id, generation, installationId, row, expectedPrivacyMode);
          return;
        }
      }
      throw error;
    }
  }
  async uploadPeriod(id, generation, installationId, row, expectedPrivacyMode) {
    const pk = usagePK(id, generation);
    const siteId = row.domainId || row.hostname;
    const summaryKey = { pk, sk: `USAGE#${installationId}#${siteId}` };
    const dailyKey = row.day ? { pk, sk: `DAY#${row.day}#INSTALL#${installationId}#HOST#${siteId}` } : null;
    // Optimistic compare-and-swap: a competing upload changes the revision,
    // causing this entire transaction to retry with a freshly computed delta.
    for (let attempt = 0; attempt < 8; attempt++) {
      const [{ Item: summary }, daily] = await Promise.all([
        this.send(GetCommand, { Key: summaryKey, ConsistentRead: true }),
        dailyKey ? this.send(GetCommand, { Key: dailyKey, ConsistentRead: true }) : Promise.resolve({})
      ]);
      const previous = daily.Item?.totalMs || 0;
      const baseline = summary?.baselineMs ?? summary?.totalMs ?? 0;
      const delta = row.day ? Math.max(0, row.totalMs - previous) : 0;
      const baselineMs = row.day ? baseline : Math.max(baseline, row.totalMs);
      if (summary?.periodVersion === 2 && !delta && baselineMs === baseline) {
        if ((await this.account(id)).generation !== generation) throw new HttpError(409, 'Cloud history changed.');
        return;
      }
      const dailyMs = (summary?.dailyMs || 0) + delta;
      const totalMs = baselineMs + dailyMs;
      if (!Number.isSafeInteger(totalMs)) throw new HttpError(400, 'Duration exceeds supported range.');
      const Item = { ...summaryKey, installationId, ...(row.domainId ? { domainId: row.domainId, encryptedHostname: row.encryptedHostname } : { hostname: row.hostname }), periodVersion: 2,
        baselineMs, dailyMs, totalMs, revision: (summary?.revision || 0) + 1, updatedAt: Date.now() };
      const summaryPut = { TableName: this.table, Item,
        ConditionExpression: !summary ? 'attribute_not_exists(pk)' : summary.revision === undefined
          ? 'totalMs = :old AND attribute_not_exists(revision)' : 'revision = :revision',
        ...(summary ? { ExpressionAttributeValues: summary.revision === undefined
          ? { ':old': summary.totalMs } : { ':revision': summary.revision } } : {}) };
      const addedRows = (summary ? 0 : 1) + (dailyKey && delta && !daily.Item ? 1 : 0);
      const items = [this.guard(id, generation, addedRows, expectedPrivacyMode), { Put: summaryPut }];
      if (dailyKey && delta) items.push({ Put: { TableName: this.table,
        Item: { ...dailyKey, installationId, ...(row.domainId ? { domainId: row.domainId, encryptedHostname: row.encryptedHostname } : { hostname: row.hostname }), day: row.day, totalMs: row.totalMs },
        ConditionExpression: daily.Item ? 'totalMs = :old' : 'attribute_not_exists(pk)',
        ...(daily.Item ? { ExpressionAttributeValues: { ':old': previous } } : {}) } });
      try { await this.transaction(items); return; }
      catch (error) {
        await this.rethrowUnlessConflict(id, generation, error, addedRows);
        await new Promise(resolve => setTimeout(resolve, (10 + Math.random() * 20) * (attempt + 1)));
      }
    }
    throw new HttpError(503, 'Concurrent update. Please retry.');
  }
  async rethrowQuota(id, generation, error, kind = 'usage', addedRows = 1) {
    if (error.name !== 'TransactionCanceledException') return;
    const profile = await this.account(id);
    if (profile.generation !== generation) throw new HttpError(409, 'Cloud history changed.');
    if (error.CancellationReasons?.[0]?.Code !== 'ConditionalCheckFailed') return;
    // Only report limits when the transaction's quota-bearing profile update
    // failed. Retrying an existing row never consumes additional quota.
    if (kind === 'install' && this.limits.maxInstallations && profile.installationCount >= this.limits.maxInstallations) {
      throw new HttpError(429, 'This account has reached its installation limit. Local tracking continues.');
    }
    if (kind === 'usage' && this.limits.maxUsageRows && (profile.usageRows || 0) + addedRows > this.limits.maxUsageRows) {
      throw new HttpError(429, 'This account has reached its cloud history limit. Local tracking continues.');
    }
  }
  async rethrowUnlessConflict(id, generation, error, addedRows) {
    await this.rethrowQuota(id, generation, error, 'usage', addedRows);
    if (error.name !== 'TransactionCanceledException' && error.name !== 'TransactionConflictException') throw error;
    if ((await this.account(id)).generation !== generation) throw new HttpError(409, 'Cloud history changed.');
    if (error.CancellationReasons?.some(reason => !['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(reason.Code))) throw error;
  }
  async usage(id, generation, cursor, range) {
    const pk = usagePK(id, generation);
    let key;
    const prefix = range ? 'DAY#' : 'USAGE#';
    if (cursor) {
      try {
        if (cursor.length > 2048) throw Error();
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (parsed.pk !== pk || typeof parsed.sk !== 'string' || !parsed.sk.startsWith(prefix)) throw Error();
        if (range ? parsed.from !== range.from || parsed.to !== range.to || Object.keys(parsed).length !== 4 : Object.keys(parsed).length !== 2) throw Error();
        key = { pk: parsed.pk, sk: parsed.sk };
        if (range && (key.sk < `DAY#${range.from}#` || key.sk > `DAY#${range.to}#~`)) throw Error();
      } catch { throw new HttpError(400, 'Invalid pagination cursor.'); }
    }
    const result = await this.send(QueryCommand, {
      KeyConditionExpression: range ? 'pk = :pk AND sk BETWEEN :from AND :to' : 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: range ? { ':pk': pk, ':from': `DAY#${range.from}#`, ':to': `DAY#${range.to}#~` } : { ':pk': pk, ':prefix': prefix },
      ConsistentRead: true, Limit: 200, ...(key ? { ExclusiveStartKey: key } : {}) });
    return { contributions: (result.Items || []).map(({ installationId, hostname, domainId, encryptedHostname, totalMs, day }) => ({ installationId, ...(hostname ? { hostname } : { domainId, encryptedHostname }), totalMs, ...(day ? { day } : {}) })),
      cursor: result.LastEvaluatedKey ? Buffer.from(JSON.stringify({ ...result.LastEvaluatedKey, ...(range || {}) })).toString('base64url') : null };
  }
  async clear(id, expected, next, migrationId, migrationInstallationId) {
    // Expected generation also serves as deletion's idempotency token. A retry can
    // never advance the generation twice and erase newly accumulated history.
    const profile = migrationId ? await this.account(id) : null;
    if (migrationId && profile.generation !== expected) {
      if (profile.lastMigrationId === migrationId && profile.lastMigrationInstallation === migrationInstallationId) return profile.generation;
      throw new HttpError(409, 'This privacy migration is no longer active.');
    }
    if (migrationId && (profile.privacyMode !== 'migrating' || profile.pendingMigrationId !== migrationId ||
        profile.pendingMigrationInstallation !== migrationInstallationId || !['recovery', 'device'].includes(profile.pendingPrivacyMode))) {
      throw new HttpError(409, 'This privacy migration is no longer active.');
    }
    const recovery = migrationId && profile.pendingPrivacyMode === 'recovery';
    const update = migrationId
      ? `SET generation = :next, usageRows = :zero, installationCount = :zero, lastMigrationId = :migration, lastMigrationInstallation = :owner, privacyMode = :target${recovery ? ', keyId = :keyId' : ''} REMOVE pendingPrivacyMode, pendingKeyId, pendingMigrationId, pendingMigrationInstallation${recovery ? '' : ', keyId'}`
      : 'SET generation = :next, usageRows = :zero, installationCount = :zero REMOVE privacyMode, keyId, pendingPrivacyMode, pendingKeyId, pendingMigrationId, pendingMigrationInstallation, lastMigrationId, lastMigrationInstallation';
    try {
      await this.transaction([{ Update: { TableName: this.table, Key: { pk: accountPK(id), sk: 'PROFILE' },
        UpdateExpression: update,
        ConditionExpression: migrationId ? `generation = :expected AND privacyMode = :migrating AND pendingMigrationId = :migration AND pendingMigrationInstallation = :owner AND pendingPrivacyMode = :target${recovery ? ' AND pendingKeyId = :keyId' : ''}`
          : 'generation = :expected',
        ExpressionAttributeValues: { ':next': next, ':expected': expected, ':zero': 0, ...(migrationId ? {
          ':migration': migrationId, ':migrating': 'migrating', ':owner': migrationInstallationId, ':target': profile.pendingPrivacyMode,
          ...(recovery ? { ':keyId': profile.pendingKeyId } : {}) } : {}) } } },
      { Put: { TableName: this.table, Item: { pk: 'CLEANUP', sk: `${id}#${expected}`, retiredPK: usagePK(id, expected), createdAt: Date.now() } } }]);
      return next;
    } catch (error) {
      if (error.name === 'TransactionCanceledException' && error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
        const current = await this.account(id);
        if (migrationId && (current.lastMigrationId !== migrationId || current.lastMigrationInstallation !== migrationInstallationId)) throw new HttpError(409, 'This privacy migration is no longer active.');
        return current.generation;
      }
      throw error;
    }
  }
  async cleanup(context) {
    const jobs = await this.send(QueryCommand, { KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'CLEANUP' }, Limit: 10 });
    for (const job of jobs.Items || []) {
      for (let page = 0; page < 10; page++) {
        if (context?.getRemainingTimeInMillis() < 10_000) return;
        const rows = await this.send(QueryCommand, { KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': job.retiredPK }, ConsistentRead: true, Limit: 100 });
        if (!rows.Items?.length) {
          await this.send(DeleteCommand, { Key: { pk: job.pk, sk: job.sk } });
          break;
        }
        for (let index = 0; index < rows.Items.length; index += 25) {
          let pending = rows.Items.slice(index, index + 25).map(({ pk, sk }) => ({ DeleteRequest: { Key: { pk, sk } } }));
          for (let attempt = 0; pending.length && attempt < 5; attempt++) {
            const result = await this.client.send(new BatchWriteCommand({ RequestItems: { [this.table]: pending } }));
            pending = result.UnprocessedItems?.[this.table] || [];
            if (pending.length) await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
          }
          if (pending.length) throw Error('Cleanup throttled');
        }
      }
    }
  }
}
export const store = new Store(DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1', maxAttempts: 4 })), process.env.TABLE_NAME, { maxInstallations: Number(process.env.MAX_INSTALLATIONS || 5), maxUsageRows: Number(process.env.MAX_USAGE_ROWS || 1000000) });
