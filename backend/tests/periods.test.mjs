import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { createHandler } from '../src/service.mjs';
const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const installation = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const generation = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const next = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';
const pk = `ACCOUNT#${id}#${generation}`;
const host = 'example.com';
const row = (totalMs, day = '2026-11-01') => ({ hostname: host, totalMs, ...(day ? { day } : {}) });
// An atomic in-memory command adapter exercises the real Store retry algorithm.
// Live integration separately verifies these expressions against DynamoDB.
function database() {
  const items = new Map([[`ACCOUNT#${id}/PROFILE`, { pk: `ACCOUNT#${id}`, sk: 'PROFILE', generation }]]);
  const key = value => `${value.pk}/${value.sk}`;
  let transactions = 0;
  const client = { async send(command) {
    const input = command.input;
    if (command.constructor.name === 'GetCommand') return { Item: structuredClone(items.get(key(input.Key))) };
    if (command.constructor.name !== 'TransactWriteCommand') throw Error('Unexpected command');
    transactions++;
    const reasons = input.TransactItems.map(part => {
      const action = part.ConditionCheck || part.Put || part.Update;
      const current = items.get(key(action.Key || action.Item));
      const values = action.ExpressionAttributeValues || {};
      const expression = action.ConditionExpression;
      let valid = true;
      if (part.ConditionCheck) valid = current?.generation === values[':g'];
      else if (expression === 'attribute_not_exists(pk)') valid = !current;
      else if (expression === 'revision = :revision') valid = current?.revision === values[':revision'];
      else if (expression === 'totalMs = :old AND attribute_not_exists(revision)') valid = current?.totalMs === values[':old'] && current?.revision === undefined;
      else if (expression === 'totalMs = :old') valid = current?.totalMs === values[':old'];
      else if (part.Update) valid = !current?.periodVersion && (!current || current.totalMs < values[':ms']);
      else throw Error(`Unknown condition ${expression}`);
      return { Code: valid ? 'None' : 'ConditionalCheckFailed' };
    });
    if (reasons.some(reason => reason.Code !== 'None')) throw Object.assign(Error('conflict'), { name: 'TransactionCanceledException', CancellationReasons: reasons });
    for (const part of input.TransactItems) {
      if (part.Put) items.set(key(part.Put.Item), structuredClone(part.Put.Item));
      if (part.Update) {
        const v = part.Update.ExpressionAttributeValues;
        items.set(key(part.Update.Key), { ...part.Update.Key, totalMs: v[':ms'], installationId: v[':id'], hostname: v[':host'] });
      }
    }
    return {};
  } };
  return { store: new Store(client, 'T'), items, summary: () => items.get(`${pk}/USAGE#${installation}#${host}`), transactions: () => transactions };
}
test('baseline migration plus daily retries preserves exact lifetime totals', async () => {
  const db = database();
  await db.store.upload(id, generation, installation, row(100, null));
  await db.store.uploadPeriod(id, generation, installation, row(100, null));
  for (const value of [20, 20, 10, 30]) await db.store.uploadPeriod(id, generation, installation, row(value));
  await db.store.uploadPeriod(id, generation, installation, row(40, '2026-11-02'));
  await db.store.uploadPeriod(id, generation, installation, row(100, null));
  assert.equal(db.summary().baselineMs, 100);
  assert.equal(db.summary().dailyMs, 70);
  assert.equal(db.summary().totalMs, 170);
  await assert.rejects(db.store.upload(id, generation, installation, row(999, null)), error => error.status === 426);
  assert.equal(db.summary().totalMs, 170);
});
test('competing same-day and different-day uploads retry atomically without losing deltas', async () => {
  const db = database();
  await db.store.uploadPeriod(id, generation, installation, row(100, null));
  await Promise.all([20, 40, 30].map(ms => db.store.uploadPeriod(id, generation, installation, row(ms))));
  await Promise.all(['2026-11-02', '2026-11-03'].map(day => db.store.uploadPeriod(id, generation, installation, row(10, day))));
  assert.equal(db.summary().totalMs, 160);
  assert.equal(db.summary().dailyMs, 60);
  assert.ok(db.transactions() > 6); // conflict required a retry
  const dailySum = [...db.items.values()].filter(item => item.day).reduce((sum, item) => sum + item.totalMs, 0);
  assert.equal(db.summary().dailyMs, dailySum);
});
test('failed generation check leaves both daily and summary records untouched, including duplicate requests', async () => {
  const db = database();
  await db.store.uploadPeriod(id, generation, installation, row(20));
  db.items.get(`ACCOUNT#${id}/PROFILE`).generation = next;
  for (const ms of [20, 40]) await assert.rejects(db.store.uploadPeriod(id, generation, installation, row(ms)), error => error.status === 409);
  assert.equal(db.summary().totalMs, 20);
  assert.equal([...db.items.values()].find(item => item.day).totalMs, 20);
});
test('summary overflow is rejected before either record changes', async () => {
  const db = database();
  await db.store.uploadPeriod(id, generation, installation, row(Number.MAX_SAFE_INTEGER, null));
  await assert.rejects(db.store.uploadPeriod(id, generation, installation, row(1)), error => error.status === 400);
  assert.equal(db.summary().totalMs, Number.MAX_SAFE_INTEGER);
  assert.equal([...db.items.values()].some(item => item.day), false);
});
test('API validates real calendar dates, distinguishes days in a batch, and forwards bounded date queries', async () => {
  const db = database(); let received;
  db.store.usage = async (...args) => { received = args; return { contributions: [], cursor: null }; };
  const api = createHandler(db.store);
  const request = (method, body, query) => ({ rawPath: '/v1/usage', body: body && JSON.stringify(body), queryStringParameters: query,
    requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: id, token_use: 'access' } } } } });
  const upload = counters => request('PUT', { generation, installationId: installation, schemaVersion: 2, counters });
  for (const day of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-1-01', 'not-a-date']) assert.equal((await api(upload([row(1, day)]))).statusCode, 400);
  assert.equal((await api(upload([row(1), row(2)]))).statusCode, 400);
  assert.equal((await api(upload([row(10, null), row(20), row(30, '2026-11-02')]))).statusCode, 200);
  assert.equal(db.summary().totalMs, 60);
  const query = { generation, from: '2026-10-26', to: '2026-11-01' };
  assert.equal((await api(request('GET', null, query))).statusCode, 200);
  assert.deepEqual(received[3], { from: query.from, to: query.to });
  assert.equal((await api(request('GET', null, { ...query, to: '2026-01-01' }))).statusCode, 400);
});
test('daily pagination cursors are bound to the account, generation and exact date range', async () => {
  let queries = 0;
  const store = new Store({ async send(command) { queries++; assert.match(command.input.KeyConditionExpression, /BETWEEN/); return {}; } }, 'T');
  const range = { from: '2026-10-26', to: '2026-11-01' };
  const cursor = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const valid = { pk, sk: `DAY#2026-11-01#INSTALL#${installation}#HOST#${host}`, ...range };
  await store.usage(id, generation, cursor(valid), range);
  for (const invalid of [{ ...valid, from: '2026-10-25' }, { ...valid, pk: 'another-account' }, { ...valid, sk: 'DAY#2027-01-01#x' }]) {
    await assert.rejects(store.usage(id, generation, cursor(invalid), range), error => error.status === 400);
  }
  await assert.rejects(store.usage(id, generation, cursor(valid)), error => error.status === 400);
  assert.equal(queries, 1);
});
