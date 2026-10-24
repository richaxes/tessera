const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1]).filter(Boolean);
for (const script of scripts) new vm.Script(script);
const engineContext = vm.createContext({});
vm.runInContext(scripts[0] + '\nglobalThis.engine = Engine;', engineContext);
const Engine = engineContext.engine;
const online = html.slice(html.indexOf('function encodeGame'), html.indexOf('function genCode'));

// Model Firestore's restriction, including nested arrays deep inside objects.
function validateFirestore(value, inArray = false) {
  if (Array.isArray(value)) {
    assert.equal(inArray, false, 'Firestore rejects nested arrays');
    value.forEach((item) => validateFirestore(item, true));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => validateFirestore(item));
  }
}
const plain = (value) => JSON.parse(JSON.stringify(value));
function harness(data) {
  let saved = plain(data);
  const ref = {};
  const context = vm.createContext({
    G: { code: 'TEST1' }, Date, console,
    toast: (message) => { throw new Error(message); },
    sleep: async () => {},
    db: { fs: {
      doc: () => ref,
      runTransaction: async (callback) => callback({
        get: async () => ({ exists: true, data: () => plain(saved) }),
        set: (target, next) => {
          assert.equal(target, ref);
          validateFirestore(next);
          saved = plain(next);
        },
      }),
    } },
  });
  vm.runInContext(online, context);
  return { context, read: () => saved };
}

test('lobby, legacy state, and missing snapshots remain readable', () => {
  const { context } = harness({ state: null });
  assert.equal(context.decodeGame(undefined), undefined);
  assert.equal(context.encodeGame({ state: null }).state, null);
  const legacy = { state: Engine.newGame(2) };
  assert.deepEqual(plain(context.decodeGame(legacy)), plain(legacy));
});

test('transactions preserve join metadata and restore full state before mutations', async () => {
  const { context, read } = harness({ code: 'TEST1', hostId: 'host', status: 'lobby', state: null, playerIds: ['host'] });
  assert.equal(await context.commit((data) => {
    data.playerIds.push('guest');
    return data;
  }), true);
  assert.deepEqual(read().playerIds, ['host', 'guest']);
  assert.equal(await context.commit((data) => {
    data.state = Engine.newGame(2);
    data.status = 'playing';
    return data;
  }), true);
  assert.equal(typeof read().state, 'string');
  assert.equal(await context.commit((data) => {
    assert.equal(Array.isArray(data.state.factories[0]), true);
    data.state = Engine.applyMove(data.state, Engine.legalMoves(data.state)[0]);
    return data;
  }), true);
  assert.equal(context.decodeGame(read()).state.seq, 1);
  const before = read();
  assert.equal(await context.commit(() => null), false);
  assert.deepEqual(read(), before);
});

for (const players of [2, 3, 4]) {
  test(`${players}-player game survives Firestore storage after every move and a rematch`, () => {
    const { context } = harness({ state: null });
    let state = Engine.newGame(players);
    assert.throws(() => validateFirestore(state), /nested arrays/);
    let moves = 0;
    while (state.status === 'playing' && moves < 2000) {
      const saved = context.encodeGame({ code: 'TEST1', status: state.status, state });
      validateFirestore(saved);
      const restored = context.decodeGame(plain(saved)).state;
      assert.deepEqual(plain(restored), plain(state));
      state = Engine.applyMove(restored, Engine.botMove(restored));
      moves++;
    }
    assert.equal(state.status, 'over');
    const finished = context.encodeGame({ state });
    validateFirestore(finished);
    assert.deepEqual(plain(context.decodeGame(finished).state), plain(state));
    const rematch = Engine.newGame(players);
    assert.deepEqual(plain(context.decodeGame(context.encodeGame({ state: rematch })).state), plain(rematch));
  });
}
