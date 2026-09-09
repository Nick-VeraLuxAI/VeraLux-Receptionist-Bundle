import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoShopTalkerBoard, formatTalkerBoard } from '../src/calls/shopGate';

test('complete name+phone+time does not NEXT-ask email', () => {
  const board = buildDemoShopTalkerBoard({
    name: 'DeSantis',
    start: '2026-09-08T12:30:00-07:00',
    startSpeak: 'Tuesday, September 8th at 12:30 PM',
    phone: '208-625-1175',
    email: null,
    writable: true,
    posted: false,
  });
  assert.equal(board.missing.length, 0);
  assert.ok(board.have.some((line) => /phone/.test(line)));
  assert.ok(!board.have.some((line) => /^email:/.test(line)));
  assert.match(board.next, /Board is complete/);
  assert.doesNotMatch(board.next, /^Ask /);
  const text = formatTalkerBoard(board);
  assert.match(text, /HAVE:/);
  assert.match(text, /phone: 208-625-1175/);
  assert.doesNotMatch(text, /MISSING:\n- phone-or-email/);
});

test('missing only contact asks phone or email, not both as required', () => {
  const board = buildDemoShopTalkerBoard({
    name: 'Nick',
    start: '2026-09-08T12:30:00-07:00',
    startSpeak: 'Tuesday, September 8th at 12:30 PM',
    writable: false,
    posted: false,
  });
  assert.ok(board.missing.some((item) => item.startsWith('phone-or-email')));
  assert.match(board.next, /one, not both/);
});

test('posted board tells talker to confirm, not re-collect', () => {
  const board = buildDemoShopTalkerBoard({
    name: 'Nick',
    start: '2026-09-08T12:30:00-07:00',
    phone: '208-625-1175',
    writable: true,
    posted: true,
  });
  assert.match(board.next, /write succeeded/i);
  assert.doesNotMatch(board.next, /ask for/i);
});
