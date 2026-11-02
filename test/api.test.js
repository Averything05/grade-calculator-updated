process.env.DB_PATH = ':memory:'; // must be set before the server (and its database) is loaded

const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../server');

let base;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

/** A tiny HTTP client that remembers its session cookie, like a browser tab. */
function makeClient() {
  const client = {
    cookie: '',
    async call(method, path, body) {
      const headers = {};
      if (body) headers['Content-Type'] = 'application/json';
      if (client.cookie) headers.Cookie = client.cookie;
      const res = await fetch(base + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      for (const setCookie of res.headers.getSetCookie()) {
        const pair = setCookie.split(';')[0];
        client.cookie = pair.endsWith('=') ? '' : pair;
      }
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    },
  };
  return client;
}

let counter = 0;
async function newUser(prefix = 'user') {
  const client = makeClient();
  const username = `${prefix}${++counter}`;
  const r = await client.call('POST', '/api/register', { username, password: 'correct horse' });
  assert.equal(r.status, 201);
  client.username = username;
  return client;
}

// ---------- static files ----------

test('serves the front end', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Grade Calculator/);
});

test('blocks path traversal', async () => {
  const res = await fetch(base + '/..%2fserver.js');
  assert.ok([403, 404].includes(res.status));
});

// ---------- accounts ----------

test('data endpoints require login', async () => {
  const anon = makeClient();
  assert.equal((await anon.call('GET', '/api/subjects')).status, 401);
  assert.equal((await anon.call('POST', '/api/subjects', { name: 'Nope' })).status, 401);
  assert.equal((await anon.call('GET', '/api/me')).status, 401);
});

test('register logs you in with a secure session cookie', async () => {
  const client = makeClient();
  const r = await client.call('POST', '/api/register', { username: ' Maria_01 ', password: 'correct horse' });
  assert.equal(r.status, 201);
  assert.equal(r.body.username, 'Maria_01');
  assert.equal('password' in r.body || 'password_hash' in r.body, false);

  const cookie = r.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  const me = await client.call('GET', '/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.username, 'Maria_01');
});

test('cookie is marked Secure when served over https', async () => {
  const res = await fetch(base + '/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ username: 'secure_user', password: 'correct horse' }),
  });
  assert.equal(res.status, 201);
  assert.match(res.headers.getSetCookie()[0], /Secure/);
});

test('register validates username and password', async () => {
  const c = makeClient();
  assert.equal((await c.call('POST', '/api/register', { username: 'ab', password: 'correct horse' })).status, 400);
  assert.equal((await c.call('POST', '/api/register', { username: 'bad name!', password: 'correct horse' })).status, 400);
  assert.equal((await c.call('POST', '/api/register', { username: 'valid_name', password: 'short' })).status, 400);
  assert.equal((await c.call('POST', '/api/register', { username: 'valid_name' })).status, 400);
});

test('usernames are unique regardless of case', async () => {
  const a = makeClient();
  assert.equal((await a.call('POST', '/api/register', { username: 'Juan', password: 'correct horse' })).status, 201);
  const b = makeClient();
  const r = await b.call('POST', '/api/register', { username: 'juan', password: 'another pass' });
  assert.equal(r.status, 409);
});

test('login works, and gives the same error for wrong password and unknown user', async () => {
  const owner = await newUser('login');
  const fresh = makeClient();

  const ok = await fresh.call('POST', '/api/login', { username: owner.username.toUpperCase(), password: 'correct horse' });
  assert.equal(ok.status, 200);
  assert.equal((await fresh.call('GET', '/api/me')).body.username, owner.username);

  const wrongPassword = await makeClient().call('POST', '/api/login', { username: owner.username, password: 'wrong password' });
  const unknownUser = await makeClient().call('POST', '/api/login', { username: 'nobody_here', password: 'whatever123' });
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownUser.status, 401);
  assert.equal(wrongPassword.body.error, unknownUser.body.error);
});

test('logout ends the session on the server', async () => {
  const client = await newUser('logout');
  const oldCookie = client.cookie;
  assert.equal((await client.call('POST', '/api/logout')).status, 204);
  assert.equal((await client.call('GET', '/api/me')).status, 401);

  // Replaying the old cookie must not work either
  const replay = makeClient();
  replay.cookie = oldCookie;
  assert.equal((await replay.call('GET', '/api/me')).status, 401);
});

test('repeated failed logins get rate limited', async () => {
  const owner = await newUser('limited');
  const attacker = makeClient();
  for (let i = 0; i < 8; i++) {
    const r = await attacker.call('POST', '/api/login', { username: owner.username, password: `guess number ${i}` });
    assert.equal(r.status, 401);
  }
  const blocked = await attacker.call('POST', '/api/login', { username: owner.username, password: 'correct horse' });
  assert.equal(blocked.status, 429);
});

// ---------- data ----------

test('subject and component lifecycle', async () => {
  const c = await newUser('life');
  let r = await c.call('POST', '/api/subjects', { name: ' Calculus 1 ', target: 85 });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Calculus 1');
  const subjectId = r.body.id;

  r = await c.call('POST', `/api/subjects/${subjectId}/components`, { name: 'Midterm', weight: 30, score: 80 });
  assert.equal(r.status, 201);
  assert.equal(r.body.maxScore, 100);
  const compId = r.body.id;

  r = await c.call('PUT', `/api/components/${compId}`, { score: 92 });
  assert.equal(r.status, 200);
  assert.equal(r.body.score, 92);
  assert.equal(r.body.weight, 30);

  r = await c.call('PUT', `/api/components/${compId}`, { score: null });
  assert.equal(r.body.score, null);

  r = await c.call('PUT', `/api/subjects/${subjectId}`, { target: 90 });
  assert.equal(r.body.target, 90);
  assert.equal(r.body.name, 'Calculus 1');

  r = await c.call('GET', '/api/subjects');
  assert.equal(r.body.find((s) => s.id === subjectId).components.length, 1);

  assert.equal((await c.call('DELETE', `/api/components/${compId}`)).status, 204);
  assert.equal((await c.call('DELETE', `/api/subjects/${subjectId}`)).status, 204);
  assert.equal((await c.call('DELETE', `/api/subjects/${subjectId}`)).status, 404);
});

test('users only see and change their own data', async () => {
  const alice = await newUser('alice');
  const bob = await newUser('bob');

  const subject = (await alice.call('POST', '/api/subjects', { name: 'Alice Physics' })).body;
  const comp = (await alice.call('POST', `/api/subjects/${subject.id}/components`, { name: 'Lab', weight: 20 })).body;

  assert.deepEqual((await bob.call('GET', '/api/subjects')).body, []);
  assert.equal((await bob.call('PUT', `/api/subjects/${subject.id}`, { name: 'Hacked' })).status, 404);
  assert.equal((await bob.call('DELETE', `/api/subjects/${subject.id}`)).status, 404);
  assert.equal((await bob.call('POST', `/api/subjects/${subject.id}/components`, { name: 'X', weight: 1 })).status, 404);
  assert.equal((await bob.call('PUT', `/api/components/${comp.id}`, { score: 1 })).status, 404);
  assert.equal((await bob.call('DELETE', `/api/components/${comp.id}`)).status, 404);

  // Alice's data is untouched
  const after = (await alice.call('GET', '/api/subjects')).body;
  assert.equal(after.length, 1);
  assert.equal(after[0].name, 'Alice Physics');
  assert.equal(after[0].components[0].score, null);
});

test('deleting a subject also deletes its components', async () => {
  const c = await newUser('cascade');
  const s = (await c.call('POST', '/api/subjects', { name: 'Physics' })).body;
  const comp = (await c.call('POST', `/api/subjects/${s.id}/components`, { name: 'Lab', weight: 10 })).body;
  await c.call('DELETE', `/api/subjects/${s.id}`);
  assert.equal((await c.call('PUT', `/api/components/${comp.id}`, { score: 1 })).status, 404);
});

test('rejects invalid input', async () => {
  const c = await newUser('invalid');
  assert.equal((await c.call('POST', '/api/subjects', { name: '   ' })).status, 400);
  assert.equal((await c.call('POST', '/api/subjects', { name: 'Bio', target: 150 })).status, 400);

  const s = (await c.call('POST', '/api/subjects', { name: 'Bio' })).body;
  const add = (body) => c.call('POST', `/api/subjects/${s.id}/components`, body);
  assert.equal((await add({ name: 'Exam', weight: 101 })).status, 400);
  assert.equal((await add({ name: 'Exam', weight: 20, maxScore: 0 })).status, 400);
  assert.equal((await add({ name: 'Exam', weight: 20, score: -5 })).status, 400);
  assert.equal((await c.call('POST', '/api/subjects/9999/components', { name: 'Exam', weight: 20 })).status, 404);
});

test('rejects malformed JSON and unknown routes', async () => {
  const c = await newUser('misc');
  let res = await fetch(base + '/api/subjects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: c.cookie },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.equal((await c.call('GET', '/api/nope')).status, 404);
});
