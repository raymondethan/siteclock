import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, BatchWriteCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { HttpError } from './service.mjs';
const accountPK = id => `ACCOUNT#${id}`;
const usagePK = (id, generation) => `${accountPK(id)}#${generation}`;
export class Store {
  constructor(client, table) { this.client = client; this.table = table; }
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
  guard(id, generation) {
    return { ConditionCheck: { TableName: this.table, Key: { pk: accountPK(id), sk: 'PROFILE' },
      ConditionExpression: 'generation = :g', ExpressionAttributeValues: { ':g': generation } } };
  }
  async transaction(items) { return this.client.send(new TransactWriteCommand({ TransactItems: items })); }
  async register(id, generation, installationId) {
    try {
      await this.transaction([this.guard(id, generation), { Update: {
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
  async upload(id, generation, installationId, row) {
    try {
      await this.transaction([this.guard(id, generation), { Update: {
        TableName: this.table, Key: { pk: usagePK(id, generation), sk: `USAGE#${installationId}#${row.hostname}` },
        UpdateExpression: 'SET totalMs = :ms, updatedAt = :now, installationId = :id, hostname = :host',
        ConditionExpression: '(attribute_not_exists(totalMs) OR totalMs < :ms) AND attribute_not_exists(periodVersion)',
        ExpressionAttributeValues: { ':ms': row.totalMs, ':now': Date.now(), ':id': installationId, ':host': row.hostname }
      } }]);
    } catch (error) {
      if (error.name === 'TransactionCanceledException') {
        if ((await this.account(id)).generation !== generation) throw new HttpError(409, 'Cloud history changed.');
        if (error.CancellationReasons?.[1]?.Code === 'ConditionalCheckFailed') {
          const { Item } = await this.send(GetCommand, { Key: { pk: usagePK(id, generation), sk: `USAGE#${installationId}#${row.hostname}` }, ConsistentRead: true });
          if (Item?.periodVersion === 2) throw new HttpError(426, 'Update SiteClock to sync daily usage.');
          return;
        }
      }
      throw error;
    }
  }
  async uploadPeriod(id, generation, installationId, row) {
    const pk = usagePK(id, generation);
    const summaryKey = { pk, sk: `USAGE#${installationId}#${row.hostname}` };
    const dailyKey = row.day ? { pk, sk: `DAY#${row.day}#INSTALL#${installationId}#HOST#${row.hostname}` } : null;
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
      const Item = { ...summaryKey, installationId, hostname: row.hostname, periodVersion: 2,
        baselineMs, dailyMs, totalMs, revision: (summary?.revision || 0) + 1, updatedAt: Date.now() };
      const summaryPut = { TableName: this.table, Item,
        ConditionExpression: !summary ? 'attribute_not_exists(pk)' : summary.revision === undefined
          ? 'totalMs = :old AND attribute_not_exists(revision)' : 'revision = :revision',
        ...(summary ? { ExpressionAttributeValues: summary.revision === undefined
          ? { ':old': summary.totalMs } : { ':revision': summary.revision } } : {}) };
      const items = [this.guard(id, generation), { Put: summaryPut }];
      if (dailyKey && delta) items.push({ Put: { TableName: this.table,
        Item: { ...dailyKey, installationId, hostname: row.hostname, day: row.day, totalMs: row.totalMs },
        ConditionExpression: daily.Item ? 'totalMs = :old' : 'attribute_not_exists(pk)',
        ...(daily.Item ? { ExpressionAttributeValues: { ':old': previous } } : {}) } });
      try { await this.transaction(items); return; }
      catch (error) {
        await this.rethrowUnlessConflict(id, generation, error);
        await new Promise(resolve => setTimeout(resolve, (10 + Math.random() * 20) * (attempt + 1)));
      }
    }
    throw new HttpError(503, 'Concurrent update. Please retry.');
  }
  async rethrowUnlessConflict(id, generation, error) {
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
    return { contributions: (result.Items || []).map(({ installationId, hostname, totalMs, day }) => ({ installationId, hostname, totalMs, ...(day ? { day } : {}) })),
      cursor: result.LastEvaluatedKey ? Buffer.from(JSON.stringify({ ...result.LastEvaluatedKey, ...(range || {}) })).toString('base64url') : null };
  }
  async clear(id, expected, next) {
    // Expected generation also serves as deletion's idempotency token. A retry can
    // never advance the generation twice and erase newly accumulated history.
    try {
      await this.transaction([{ Update: { TableName: this.table, Key: { pk: accountPK(id), sk: 'PROFILE' },
        UpdateExpression: 'SET generation = :next', ConditionExpression: 'generation = :expected',
        ExpressionAttributeValues: { ':next': next, ':expected': expected } } },
      { Put: { TableName: this.table, Item: { pk: 'CLEANUP', sk: `${id}#${expected}`, retiredPK: usagePK(id, expected), createdAt: Date.now() } } }]);
      return next;
    } catch (error) {
      if (error.name === 'TransactionCanceledException' && error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
        return (await this.account(id)).generation;
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
export const store = new Store(DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1', maxAttempts: 4 })), process.env.TABLE_NAME);
