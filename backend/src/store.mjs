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
        ConditionExpression: 'attribute_not_exists(totalMs) OR totalMs < :ms',
        ExpressionAttributeValues: { ':ms': row.totalMs, ':now': Date.now(), ':id': installationId, ':host': row.hostname }
      } }]);
    } catch (error) {
      if (error.name === 'TransactionCanceledException') {
        if ((await this.account(id)).generation !== generation) throw new HttpError(409, 'Cloud history changed.');
        if (error.CancellationReasons?.[1]?.Code === 'ConditionalCheckFailed') return;
      }
      throw error;
    }
  }
  async usage(id, generation, cursor) {
    const pk = usagePK(id, generation);
    let key;
    if (cursor) {
      try {
        if (cursor.length > 2048) throw Error();
        key = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (key.pk !== pk || typeof key.sk !== 'string' || !key.sk.startsWith('USAGE#') || Object.keys(key).length !== 2) throw Error();
      } catch { throw new HttpError(400, 'Invalid pagination cursor.'); }
    }
    const result = await this.send(QueryCommand, { KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': pk, ':prefix': 'USAGE#' }, ConsistentRead: true, Limit: 200,
      ...(key ? { ExclusiveStartKey: key } : {}) });
    return { contributions: (result.Items || []).map(({ installationId, hostname, totalMs }) => ({ installationId, hostname, totalMs })),
      cursor: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url') : null };
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
