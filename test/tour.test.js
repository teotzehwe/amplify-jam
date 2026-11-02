import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  adminTourSteps,
  clearTourSeen,
  hostTourSteps,
  markTourSeen,
  playerTourSteps,
  tourSeen,
} from '../public/js/tour.js';

describe('tour persistence', () => {
  beforeEach(() => {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    };
  });

  it('marks a tour as seen and clears it', () => {
    assert.equal(tourSeen('player'), false);
    markTourSeen('player');
    assert.equal(tourSeen('player'), true);
    clearTourSeen('player');
    assert.equal(tourSeen('player'), false);
  });

  it('keeps admin and player seen flags separate', () => {
    markTourSeen('player');
    assert.equal(tourSeen('admin'), false);
    markTourSeen('admin');
    assert.equal(tourSeen('admin'), true);
  });
});

describe('playerTourSteps', () => {
  it('shows join steps before sign-in and profile steps after', () => {
    const before = playerTourSteps({
      you: () => null,
      entryMode: () => 'join',
      suggestionsOn: () => true,
    }).filter((s) => !s.when || s.when());

    assert.ok(before.some((s) => s.selector === '[data-tour="player-join"]'));
    assert.ok(!before.some((s) => s.selector === '[data-tour="player-signin"]'));
    assert.ok(!before.some((s) => s.selector === '[data-tour="player-songs"]'));

    const signingIn = playerTourSteps({
      you: () => null,
      entryMode: () => 'signin',
      suggestionsOn: () => true,
    }).filter((s) => !s.when || s.when());

    assert.ok(signingIn.some((s) => s.selector === '[data-tour="player-signin"]'));
    assert.ok(!signingIn.some((s) => s.selector === '[data-tour="player-join"]'));

    const after = playerTourSteps({
      you: () => ({ id: 'p1' }),
      entryMode: () => 'join',
      suggestionsOn: () => true,
    }).filter((s) => !s.when || s.when());

    assert.ok(!after.some((s) => s.selector === '[data-tour="player-join"]'));
    assert.ok(after.some((s) => s.selector === '[data-tour="player-songs"]'));
    assert.ok(after.some((s) => s.selector === '[data-tour="player-suggest"]'));
  });

  it('omits suggest when room requests are off', () => {
    const steps = playerTourSteps({
      you: () => ({ id: 'p1' }),
      suggestionsOn: () => false,
    }).filter((s) => !s.when || s.when());

    assert.ok(!steps.some((s) => s.selector === '[data-tour="player-suggest"]'));
  });
});

describe('adminTourSteps', () => {
  it('walks the full admin dashboard across tabs', () => {
    const steps = adminTourSteps();
    assert.equal(hostTourSteps, adminTourSteps);

    const selectors = steps.map((s) => s.selector).filter(Boolean);
    assert.deepEqual(selectors, [
      '[data-tour="host-tabs"]',
      '[data-tour="host-stage"]',
      '[data-tour="host-now"]',
      '[data-tour="host-roster"]',
      '[data-tour="host-requests"]',
      '[data-tour="host-setlist"]',
      '[data-tour="host-share"]',
      '[data-tour="host-band"]',
      '[data-tour="host-gates"]',
      '[data-tour="host-ops"]',
    ]);

    const tabs = [...new Set(steps.map((s) => s.tab).filter(Boolean))];
    assert.deepEqual(tabs.sort(), ['now', 'roster', 'settings', 'songs']);
    assert.ok(steps[0].title.toLowerCase().includes('admin'));
    assert.ok(steps.some((s) => /five tabs/i.test(s.title)));
    assert.ok(steps.some((s) => /Users is accounts/i.test(s.body)));
    assert.ok(steps.some((s) => /did not sign up/i.test(s.body)));
    assert.ok(steps.some((s) => /backup/i.test(s.body)));
  });
});
