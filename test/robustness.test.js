// Robustness tests: database errors and invalid payloads must produce an HTTP
// error response and leave the server running.
//
// Run with: npm test
//
// The app is started in-process on a random local port with a temporary SQLite
// file. The OpenAI client is replaced with a local stub, so no API key is
// needed and no network calls are made.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balss-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
delete process.env.OPENAI_API_KEY;
delete process.env.SENTRY_DSN;
delete process.env.REQUIRE_BEARER;

// Stub for the `openai` module: classifies every requested product as "dairy"
// and echoes the names back exactly as they were sent (including repeats).
class FakeOpenAI {
  constructor() {
    this.chat = {
      completions: {
        create: async (params) => {
          const prompt = params.messages.find(m => m.role === 'user').content;
          const match = prompt.match(/^Produkti: (.*)$/m);
          const names = match ? match[1].split(', ') : [];
          const items = names.map(product => ({ product, category: 'dairy' }));
          return { choices: [{ message: { content: JSON.stringify(items) } }] };
        }
      }
    };
  }
}
const openaiPath = require.resolve('openai');
require.cache[openaiPath] = {
  id: openaiPath,
  filename: openaiPath,
  loaded: true,
  exports: FakeOpenAI,
  children: [],
  paths: []
};

const { app, db } = require('../server.js');

const USER_ID = 'u-1700000000-abcdefgh';
let server;
let baseUrl;

// Errors that no callback or try/catch picked up end up here; the tests expect none
const unhandledErrors = [];
process.on('uncaughtException', (err) => unhandledErrors.push(err));
process.on('unhandledRejection', (err) => unhandledErrors.push(err));

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function dbExec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

async function request(method, urlPath, body) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User-Id': USER_ID },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, json, text };
}

// Poll until `check` returns a truthy value (background writes finish shortly
// after the response has been sent)
async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function assertServerHealthy() {
  const res = await request('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'healthy');
  assert.deepEqual(unhandledErrors, []);
}

// A player as the DartMaster web app sends it
function makePlayer(id, name, avatar) {
  return {
    id,
    name,
    avatar,
    stats: {
      totalThrows: 0,
      totalPoints: 0,
      highestScore: 0,
      hundredEighties: 0,
      oneFortiesPlus: 0,
      oneHundredPlus: 0,
      averagePPR: 0,
      checkoutPercentage: 0,
      history: []
    }
  };
}

before(async () => {
  // Wait until the schema from server.js has been created
  await waitFor(async () => {
    try {
      await dbAll('SELECT 1 FROM dart_games LIMIT 1');
      return true;
    } catch (e) {
      return false;
    }
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => db.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('GET /api/health responds with status and uptime', async () => {
  const res = await request('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'healthy');
  assert.equal(typeof res.json.uptime, 'number');
  assert.ok(res.json.requestId);
});

test('POST /api/dart/players stores the players the web app sends', async () => {
  const players = [
    makePlayer('1', 'Guntis', '🎯'),
    makePlayer(String(Date.now()), 'Jānis', 'https://picsum.photos/seed/Janis/200')
  ];
  const saved = await request('POST', '/api/dart/players', { players });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.success, true);
  assert.equal(saved.json.message, 'Saved 2 player(s)');

  const listed = await request('GET', '/api/dart/players');
  assert.equal(listed.status, 200);
  assert.equal(listed.json.players.length, 2);
  const guntis = listed.json.players.find(p => p.id === '1');
  assert.equal(guntis.name, 'Guntis');
  assert.equal(guntis.avatar, '🎯');
  assert.deepEqual(guntis.stats, players[0].stats);

  // The app sends back what it received (including created_at / updated_at)
  const renamed = listed.json.players.map(p => (p.id === '1' ? { ...p, name: 'Guntis B.' } : p));
  const resaved = await request('POST', '/api/dart/players', { players: renamed });
  assert.equal(resaved.status, 200);
  const relisted = await request('GET', '/api/dart/players');
  assert.equal(relisted.json.players.length, 2);
  assert.equal(relisted.json.players.find(p => p.id === '1').name, 'Guntis B.');
});

test('POST /api/dart/players accepts an empty list and a player without avatar or stats', async () => {
  const empty = await request('POST', '/api/dart/players', { players: [] });
  assert.equal(empty.status, 200);
  assert.equal(empty.json.message, 'Saved 0 player(s)');

  const minimal = await request('POST', '/api/dart/players', { players: [{ id: 'minimal', name: 'Minimal' }] });
  assert.equal(minimal.status, 200);
  const rows = await dbAll('SELECT avatar, stats FROM dart_players WHERE id = ?', ['minimal']);
  assert.deepEqual(rows, [{ avatar: '', stats: '{}' }]);
});

test('POST /api/dart/players answers 400 for invalid payloads and stores nothing', async () => {
  const valid = makePlayer('valid-in-bad-batch', 'Valid', '🏆');
  const invalidBodies = [
    {},
    { players: 'not-an-array' },
    { players: [{ id: 'no-name' }] },
    { players: [valid, { id: 'no-name' }] },
    { players: [{ id: 'empty-name', name: '' }] },
    { players: [{ id: 'null-name', name: null }] },
    { players: [{ id: 'object-name', name: { first: 'A' } }] },
    { players: [{ name: 'No id' }] },
    { players: [{ id: 42, name: 'Numeric id' }] },
    { players: [{ id: '', name: 'Empty id' }] },
    { players: [null] },
    { players: ['just a string'] },
    { players: [['array', 'item']] },
    { players: [{ id: 'bad-avatar', name: 'Bad avatar', avatar: { url: 'x' } }] },
    { players: [{ id: 'long-name', name: 'x'.repeat(201) }] },
    { players: [{ id: 'i'.repeat(129), name: 'Long id' }] },
    { players: Array.from({ length: 1001 }, (_, i) => ({ id: `bulk-${i}`, name: 'Bulk' })) }
  ];

  for (const body of invalidBodies) {
    const res = await request('POST', '/api/dart/players', body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body).slice(0, 80)}`);
    assert.equal(typeof res.json.error, 'string');
    assert.ok(res.json.requestId);
  }

  const rows = await dbAll(
    `SELECT id FROM dart_players
     WHERE id IN ('valid-in-bad-batch', 'no-name', 'empty-name', 'null-name', 'bad-avatar', 'long-name')
        OR id LIKE 'bulk-%' OR id IS NULL`
  );
  assert.deepEqual(rows, []);
  await assertServerHealthy();
});

test('POST /api/learn stores a correction and a repeat updates it', async () => {
  const first = await request('POST', '/api/learn', { product: 'Testa kefīrs', correctCategory: 'beverages' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { success: true, message: 'Learning saved' });

  let rows = await dbAll('SELECT * FROM products WHERE name = ?', ['Testa kefīrs']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].normalized_name, 'testa kefirs');
  assert.equal(rows[0].category, 'beverages');
  assert.equal(rows[0].source, 'manual');
  assert.equal(rows[0].confidence, 1);

  const second = await request('POST', '/api/learn', { product: 'Testa kefīrs', correctCategory: 'dairy' });
  assert.equal(second.status, 200);

  rows = await dbAll('SELECT * FROM products WHERE name = ?', ['Testa kefīrs']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'dairy');
  assert.equal(rows[0].source, 'manual');

  const suggestions = await request('GET', `/api/suggestions?query=${encodeURIComponent('Testa kefīrs')}`);
  assert.equal(suggestions.status, 200);
  assert.deepEqual(
    suggestions.json.suggestions.map(s => [s.name, s.category]),
    [['Testa kefīrs', 'dairy']]
  );
});

test('POST /api/learn answers 400 for missing or non-string fields', async () => {
  const invalidBodies = [
    {},
    { product: 'Only product' },
    { correctCategory: 'dairy' },
    { product: 123, correctCategory: 'dairy' },
    { product: ['a'], correctCategory: 'dairy' },
    { product: 'Siers', correctCategory: { slug: 'dairy' } }
  ];
  for (const body of invalidBodies) {
    const res = await request('POST', '/api/learn', body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  await assertServerHealthy();
});

test('POST /api/classify-products stores a repeated new name once', async () => {
  const res = await request('POST', '/api/classify-products', {
    products: ['zz testa produkts', 'zz testa produkts', 'zz cits produkts']
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.aiUsed, true);
  assert.equal(res.json.classifications.length, 3);

  // The rows are written in the background after the response
  await waitFor(async () => {
    const rows = await dbAll(`SELECT name FROM products WHERE name LIKE 'zz %'`);
    return rows.length === 2;
  });
  const rows = await dbAll(`SELECT name, category, source FROM products WHERE name LIKE 'zz %' ORDER BY name`);
  assert.deepEqual(rows, [
    { name: 'zz cits produkts', category: 'dairy', source: 'ai' },
    { name: 'zz testa produkts', category: 'dairy', source: 'ai' }
  ]);
  await assertServerHealthy();
});

test('POST /api/classify-products keeps an existing row when the same name comes back', async () => {
  // Same name, but stored under a different normalized form, so the lookup
  // misses it and the name is classified again
  await new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO products (name, normalized_name, category, confidence, source) VALUES (?, ?, ?, ?, ?)`,
      ['zy esošs produkts', 'legacy-form', 'snacks', 1.0, 'manual'],
      (err) => (err ? reject(err) : resolve())
    );
  });

  const res = await request('POST', '/api/classify-products', { products: ['zy esošs produkts'] });
  assert.equal(res.status, 200);

  // Give the background write time to finish, then check the row is unchanged
  await new Promise(resolve => setTimeout(resolve, 150));
  const rows = await dbAll(`SELECT category, source FROM products WHERE name = ?`, ['zy esošs produkts']);
  assert.deepEqual(rows, [{ category: 'snacks', source: 'manual' }]);
  await assertServerHealthy();
});

test('a failing database write is answered with 500 and the server keeps running', async () => {
  await dbExec('ALTER TABLE dart_players RENAME TO dart_players_moved');
  await dbExec('ALTER TABLE products RENAME TO products_moved');
  try {
    const players = await request('POST', '/api/dart/players', { players: [makePlayer('db-error', 'Db Error', '🎯')] });
    assert.equal(players.status, 500);
    assert.equal(players.json.error, 'Failed to save players');

    const listed = await request('GET', '/api/dart/players');
    assert.equal(listed.status, 500);

    const removed = await request('DELETE', '/api/dart/players/db-error');
    assert.equal(removed.status, 500);

    const learned = await request('POST', '/api/learn', { product: 'Db kļūda', correctCategory: 'dairy' });
    assert.equal(learned.status, 500);
    assert.equal(learned.json.error, 'Learning failed');

    await assertServerHealthy();
  } finally {
    await dbExec('ALTER TABLE dart_players_moved RENAME TO dart_players');
    await dbExec('ALTER TABLE products_moved RENAME TO products');
  }

  const players = await request('POST', '/api/dart/players', { players: [makePlayer('db-ok', 'Db Ok', '🎯')] });
  assert.equal(players.status, 200);
  const learned = await request('POST', '/api/learn', { product: 'Db kārtībā', correctCategory: 'dairy' });
  assert.equal(learned.status, 200);
});

test('POST /api/dart/games saves a game and GET returns it', async () => {
  const game = {
    id: 'game-1',
    type: 'X01',
    mode: '501',
    players: ['1'],
    winner: '1',
    playerStats: { 1: { average: 60 } },
    legsToWin: 3,
    doubleIn: false,
    doubleOut: true,
    startTime: 1700000000000,
    endTime: 1700000600000
  };
  const saved = await request('POST', '/api/dart/games', game);
  assert.equal(saved.status, 200);
  assert.equal(saved.json.message, 'Game saved');

  const listed = await request('GET', '/api/dart/games');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.games, [game]);

  const missingId = await request('POST', '/api/dart/games', { type: 'X01' });
  assert.equal(missingId.status, 400);
});

test('no unhandled errors were raised during the run', async () => {
  // Leave time for background writes from the earlier tests to settle
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(unhandledErrors, []);
  await assertServerHealthy();
});
