const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter(Boolean);
const pure = vm.createContext({});
vm.runInContext(scripts[0] + scripts[1] + '\nglobalThis.api = { Engine, MatchFlow, TurnCues };', pure);
const { Engine, MatchFlow, TurnCues } = pure.api;
const clone = (d) => JSON.parse(JSON.stringify(d));
function table(size = 2) {
  let state = Engine.newGame(size, Math.random, 0);
  for (let i = 0; state.status !== 'over' && i < 2000; i++) state = Engine.applyMove(state, Engine.botMove(state));
  assert.equal(state.status, 'over');
  return { code: 'TEST1', hostId: 'host', size, createdAt: 1, matchId: 'old', matchNumber: 1, startingSeat: 0, status: 'over', state: clone(state), seats: [{ id: 'host', nick: 'Házigazda', bot: false }, ...Array.from({ length: size - 1 }, (_, i) => ({ id: 'guest' + i, nick: 'Vendég ' + i, bot: false }))], playerIds: ['host', ...Array.from({ length: size - 1 }, (_, i) => 'guest' + i)] };
}

test('host proposal preserves the finished board until the other human accepts', () => {
  const d = table(), oldState = clone(d.state), oldSeats = clone(d.seats);
  assert.equal(MatchFlow.request(clone(d), 'guest0', 'wrong'), null);
  MatchFlow.request(d, 'host', 'request-1');
  assert.equal(d.status, 'over');
  assert.deepEqual(d.state, oldState);
  assert.equal(d.rematch.firstSeat, 1);
  assert.equal(MatchFlow.accept(clone(d), 'spectator', 'request-1'), null);
  assert.equal(MatchFlow.accept(clone(d), 'host', 'request-1'), null);
  assert.equal(MatchFlow.accept(clone(d), 'guest0', 'stale-request'), null);
  MatchFlow.accept(d, 'guest0', 'request-1');
  assert.equal(d.status, 'playing');
  assert.equal(d.state.seq, 0);
  assert.equal(d.state.turn, 1);
  assert.equal(d.state.initialFirst, 1);
  assert.equal(d.matchNumber, 2);
  assert.equal(d.matchId, 'request-1');
  assert.equal(d.rematch, null);
  assert.deepEqual(d.seats, oldSeats);
  assert.equal(d.code, 'TEST1');
  assert.equal(MatchFlow.accept(d, 'guest0', 'request-1'), null);
});

test('declining, cancelling and stale approvals cannot restart another proposal', () => {
  const d = table();
  MatchFlow.request(d, 'host', 'request-1');
  assert.equal(MatchFlow.cancel(clone(d), 'spectator', 'request-1'), null);
  MatchFlow.cancel(d, 'guest0', 'request-1');
  assert.equal(d.status, 'over');
  MatchFlow.request(d, 'host', 'request-2');
  assert.equal(MatchFlow.accept(d, 'guest0', 'request-1'), null);
  assert.equal(MatchFlow.request(d, 'host', 'request-3'), null);
  MatchFlow.cancel(d, 'host', 'request-2');
  assert.equal(d.rematch, null);
});

test('all humans must approve; bots do not block a rematch', () => {
  const d = table(3);
  MatchFlow.request(d, 'host', 'new');
  MatchFlow.accept(d, 'guest0', 'new');
  assert.equal(d.status, 'over');
  MatchFlow.accept(d, 'guest1', 'new');
  assert.equal(d.status, 'playing');
  const botTable = table();
  botTable.seats[1] = { id: null, nick: '', bot: true };
  MatchFlow.request(botTable, 'host', 'bot-new');
  assert.equal(botTable.status, 'playing');
});

test('the first match is random; subsequent starts rotate independently of the winner and round marker', () => {
  const d = table(); d.status = 'lobby'; d.state = null;
  assert.equal(MatchFlow.first(clone(d), 'guest0', 'no'), null);
  MatchFlow.first(d, 'host', 'first', () => .75);
  assert.equal(d.startingSeat, 1);
  d.state.status = d.status = 'over'; d.state.winners = [1]; d.state.firstNext = 1;
  MatchFlow.request(d, 'host', 'next'); MatchFlow.accept(d, 'guest0', 'next');
  assert.equal(d.startingSeat, 0);
  d.state.status = d.status = 'over';
  MatchFlow.request(d, 'host', 'third'); MatchFlow.accept(d, 'guest0', 'third');
  assert.equal(d.startingSeat, 1);
  const legacy = table(); delete legacy.startingSeat; delete legacy.state.initialFirst;
  assert.equal(MatchFlow.nextSeat(legacy, () => .75), 1);
});

test('turn cues distinguish new matches and suppress duplicate snapshot/render notifications', () => {
  const cues = TurnCues.create();
  assert.equal(cues.observe('match1:0:0', true), true);
  assert.equal(cues.observe('match1:0:0', true), false);
  assert.equal(cues.observe('match1:1:1', false), false);
  assert.equal(cues.observe('match1:2:0', true), true);
  assert.equal(cues.observe('match2:0:0', true), true);
});

test('the first-player marker selects the next round starter, independently of match rotation', () => {
  let state = Engine.newGame(2, Math.random, 1);
  state.factories = [[0], [], [], [], []]; state.center = [1];
  state = Engine.applyMove(state, { src: 'c', color: 1, line: 0 });
  assert.equal(state.firstNext, 1);
  state = Engine.applyMove(state, { src: 0, color: 0, line: 0 });
  assert.equal(state.round, 2);
  assert.equal(state.turn, 1);
  assert.equal(state.initialFirst, 1);
});

function client(id, database) {
  const listeners = {}, app = { innerHTML: '', addEventListener: (name, cb) => { listeners[name] = cb; } };
  const overlay = { querySelector: () => null, appendChild() {}, addEventListener() {} };
  let toneCount = 0;
  class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    createOscillator() { return { frequency: {}, connect() {}, start() { toneCount++; }, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  }
  const document = { title: '', visibilityState: 'visible', getElementById: (name) => name === 'app' ? app : overlay, addEventListener() {}, createElement: () => ({ remove() {} }) };
  const context = vm.createContext({ document, window: { AudioContext }, localStorage: { getItem: () => null, setItem() {} }, console: { warn() {} }, setTimeout: () => 1, clearTimeout() {}, Math, Date });
  vm.runInContext(scripts[0] + scripts[1], context);
  const hook = `globalThis.testApi = {
    openTable, commit, render, unlockAudio, notifyTurn, decodeGame,
    game: () => G,
    setGame: (game) => { G = game; view = 'game'; },
    sound: (value) => { soundEnabled = value; },
    connect: (database, id) => { db = database; myId = id; }
  };\n`;
  vm.runInContext(scripts[2].replace('// keep a local game across page updates', hook + '// keep a local game across page updates'), context);
  const api = context.testApi;
  const db = {
    doc: () => ({ onSnapshot: (cb) => {
      const notify = () => cb({ exists: true, metadata: { fromCache: false }, data: () => api.decodeGame(clone(database.saved)) });
      database.listeners.push(notify); notify(); return () => {};
    } }),
    fs: { doc: () => ({}), runTransaction: async (callback) => callback({
      get: async () => ({ exists: true, data: () => clone(database.saved) }),
      set: (_, data) => { database.saved = clone(data); database.listeners.forEach((cb) => cb()); },
    }) },
  };
  api.connect(db, id);
  return { api, context, tones: () => toneCount, app, listeners, document };
}

test('two subscribed clients automatically replace a completed high-sequence game after approval', async () => {
  const d = table(), database = { saved: { ...d, state: JSON.stringify(d.state) }, listeners: [] };
  const host = client('host', database), guest = client('guest0', database);
  host.api.openTable('TEST1'); guest.api.openTable('TEST1');
  assert.ok(host.api.game().state.seq > 0);
  await host.api.commit((data) => MatchFlow.request(data, 'host', 'rematch'));
  assert.equal(host.api.game().state.status, 'over');
  assert.match(guest.app.innerHTML, /Igen, jöhet!/);
  await guest.api.commit((data) => MatchFlow.accept(data, 'guest0', 'rematch'));
  for (const c of [host, guest]) {
    assert.equal(c.api.game().doc.matchId, 'rematch');
    assert.equal(c.api.game().state.seq, 0);
    assert.equal(c.api.game().state.status, 'playing');
  }
  assert.deepEqual(clone(host.api.game().state), clone(guest.api.game().state));
  assert.match(guest.app.innerHTML, /Te következel/);
});

test('sound plays while the page is visible, once per own turn, and respects mute', () => {
  const c = client('host', { listeners: [] });
  c.api.setGame({ mode: 'online', code: 'TEST1', doc: { matchId: 'first' }, seats: table().seats, state: Engine.newGame(2, Math.random, 0) });
  c.api.unlockAudio(); c.api.render(); c.api.render();
  assert.equal(c.document.visibilityState, 'visible');
  assert.equal(c.tones(), 2);
  c.api.game().state.turn = 1; c.api.game().state.seq = 1; c.api.render();
  assert.equal(c.tones(), 2);
  c.api.game().state.turn = 0; c.api.game().state.seq = 2; c.api.render();
  assert.equal(c.tones(), 4);
  c.api.sound(false); c.api.game().state.seq = 4; c.api.render();
  assert.equal(c.tones(), 4);
});
