import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, HttpError } from '../src/service.mjs';
import { Store } from '../src/store.mjs';
const user = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const device = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const generation = '11111111-1111-4111-8111-111111111111';
const nextGeneration = '22222222-2222-4222-8222-222222222222';
class MemoryStore {
  profiles = new Map(); rows = new Map();
  async account(id) {
    if (!this.profiles.has(id)) this.profiles.set(id, { generation });
    return this.profiles.get(id);
  }
  async guard(id, g) { if ((await this.account(id)).generation !== g) throw new HttpError(409, 'Cloud history changed.'); }
  async register(id, g) { await this.guard(id, g); }
  async upload(id, g, installationId, row) {
    await this.guard(id, g);
    const key = `${id}/${g}/${installationId}/${row.hostname}`;
    this.rows.set(key, { installationId, ...row, totalMs: Math.max(row.totalMs, this.rows.get(key)?.totalMs || 0) });
  }
  async usage(id, g) { return { contributions: [...this.rows].filter(([key]) => key.startsWith(`${id}/${g}/`)).map(([, row]) => row), cursor: null }; }
  async clear(id, g, next) { const p = await this.account(id); if (p.generation === g) p.generation = next; return p.generation; }
}
function request(method, path, body, id = user, query) {
  return { rawPath: path, requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: id, token_use: 'access' } } } },
    body: body === undefined ? undefined : JSON.stringify(body), queryStringParameters: query };
}
const upload = (ms, installationId = device) => ({ generation, installationId, counters: [{ hostname: 'example.com', totalMs: ms }] });
test('API retries and concurrent installations are additive without duplicate uploads', async () => {
  const store = new MemoryStore(); const api = createHandler(store);
  await Promise.all([api(request('PUT', '/v1/usage', upload(20))), api(request('PUT', '/v1/usage', upload(10, other)))]);
  await api(request('PUT', '/v1/usage', upload(20))); await api(request('PUT', '/v1/usage', upload(15)));
  const result = await api(request('GET', '/v1/usage', undefined, user, { generation }));
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).contributions.reduce((sum, row) => sum + row.totalMs, 0), 30);
});
test('API account ownership comes exclusively from claims', async () => {
  const store = new MemoryStore(); const api = createHandler(store);
  await api(request('PUT', '/v1/usage', { ...upload(20), accountId: other }));
  const result = await api(request('GET', '/v1/usage', undefined, other, { generation }));
  assert.deepEqual(JSON.parse(result.body).contributions, []);
  const anonymous = await api({ rawPath: '/v1/account' }); assert.equal(anonymous.statusCode, 401);
  const idToken = request('GET', '/v1/account'); idToken.requestContext.authorizer.jwt.claims.token_use = 'id';
  assert.equal((await api(idToken)).statusCode, 401);
});
test('API rejects malformed counters and overlarge batches before writing', async () => {
  const store = new MemoryStore(); const api = createHandler(store);
  for (const row of [{ hostname: '__proto__', totalMs: 1 }, { hostname: 'www.example.com', totalMs: 1 },
    { hostname: 'example.com/path', totalMs: 1 }, { hostname: 'example.com', totalMs: -1 },
    { hostname: 'example.com', totalMs: 1.5 }, { hostname: 'example.com', totalMs: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal((await api(request('PUT', '/v1/usage', { ...upload(1), counters: [row] }))).statusCode, 400);
  }
  assert.equal((await api(request('PUT', '/v1/usage', { ...upload(1), counters: Array(51).fill(upload(1).counters[0]) }))).statusCode, 400);
  assert.equal(store.rows.size, 0);
});
test('deletion is conditional and stale installations cannot resurrect history', async () => {
  const store = new MemoryStore(); const api = createHandler(store);
  await api(request('PUT', '/v1/usage', upload(20)));
  const deleted = JSON.parse((await api(request('DELETE', '/v1/usage', { generation }))).body);
  const repeated = JSON.parse((await api(request('DELETE', '/v1/usage', { generation }))).body);
  assert.equal(repeated.generation, deleted.generation);
  assert.equal((await api(request('PUT', '/v1/usage', upload(100)))).statusCode, 409);
  assert.deepEqual(JSON.parse((await api(request('GET', '/v1/usage', undefined, user, deleted))).body).contributions, []);
});
test('partial upload failure can safely retry the entire batch', async () => {
  const store = new MemoryStore(); const api = createHandler(store);
  const original = store.upload.bind(store); let fail = true;
  store.upload = async (...args) => { if (args[3].hostname === 'other.test' && fail) throw new HttpError(503, 'Retry.'); return original(...args); };
  const body = { ...upload(20), counters: [...upload(20).counters, { hostname: 'other.test', totalMs: 10 }] };
  assert.equal((await api(request('PUT', '/v1/usage', body))).statusCode, 503);
  fail = false; assert.equal((await api(request('PUT', '/v1/usage', body))).statusCode, 200);
  assert.equal([...store.rows.values()].reduce((sum, row) => sum + row.totalMs, 0), 30);
});
test('DynamoDB uploads atomically guard generation and monotonicity', async () => {
  const commands = []; const store = new Store({ async send(command) { commands.push(command); return {}; } }, 'T');
  await store.upload(user, generation, device, upload(20).counters[0]);
  const transaction = commands[0].input.TransactItems;
  assert.equal(transaction[0].ConditionCheck.ConditionExpression, 'generation = :g');
  assert.equal(transaction[1].Update.ConditionExpression, 'attribute_not_exists(totalMs) OR totalMs < :ms');
  assert.equal(transaction[1].Update.Key.pk, `ACCOUNT#${user}#${generation}`);
});
test('DynamoDB conditional duplicate succeeds, generation conflict fails', async () => {
  let current = generation;
  const store = new Store({ async send(command) {
    if (command.constructor.name === 'GetCommand') return { Item: { generation: current } };
    throw Object.assign(Error('condition'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }] });
  } }, 'T');
  await store.upload(user, generation, device, upload(20).counters[0]);
  current = nextGeneration;
  await assert.rejects(store.upload(user, generation, device, upload(20).counters[0]), error => error.status === 409);
});
test('DynamoDB cursor cannot cross account or generation boundaries', async () => {
  const store = new Store({ async send() { throw Error('Should not query'); } }, 'T');
  const cursor = Buffer.from(JSON.stringify({ pk: `ACCOUNT#${other}#${generation}`, sk: `USAGE#${device}#example.com` })).toString('base64url');
  await assert.rejects(store.usage(user, generation, cursor), error => error.status === 400);
});
test('DynamoDB deletion updates generation and persists cleanup in one transaction', async () => {
  let command;
  const store = new Store({ async send(value) { command = value; return {}; } }, 'T');
  await store.clear(user, generation, nextGeneration);
  const items = command.input.TransactItems;
  assert.equal(items[0].Update.ConditionExpression, 'generation = :expected');
  assert.equal(items[1].Put.Item.retiredPK, `ACCOUNT#${user}#${generation}`);
});
test('cleanup retries unprocessed deletes and removes the job only after data is gone', async () => {
  let queried = 0, batches = 0, deletedJob = false;
  const store = new Store({ async send(command) {
    if (command.constructor.name === 'QueryCommand') {
      if (command.input.ExpressionAttributeValues[':pk'] === 'CLEANUP') return { Items: [{ pk: 'CLEANUP', sk: 'job', retiredPK: 'old' }] };
      return { Items: queried++ ? [] : [{ pk: 'old', sk: 'row' }] };
    }
    if (command.constructor.name === 'BatchWriteCommand') return batches++ ? {} : { UnprocessedItems: command.input.RequestItems };
    if (command.constructor.name === 'DeleteCommand') deletedJob = true;
    return {};
  } }, 'T');
  await store.cleanup({ getRemainingTimeInMillis: () => 120000 });
  assert.equal(batches, 2); assert.equal(deletedJob, true);
});
