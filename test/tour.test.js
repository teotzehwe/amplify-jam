import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
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

  it('keeps host and player seen flags separate', () => {
    markTourSeen('player');
    assert.equal(tourSeen('host'), false);
    markTourSeen('host');
    assert.equal(tourSeen('host'), true);
  });
});

describe('playerTourSteps', () => {
  it('shows join steps before sign-in and profile steps after', () => {
    const before = playerTourSteps({
      you: () => null,
      suggestionsOn: () => true,
    }).filter((s) => !s.when || s.when());

    assert.ok(before.some((s) => s.selector === '[data-tour="player-join"]'));
    assert.ok(!before.some((s) => s.selector === '[data-tour="player-songs"]'));

    const after = playerTourSteps({
      you: () => ({ id: 'p1' }),
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

describe('hostTourSteps', () => {
  it('covers tabs, now, songs, share, and the hard rule', () => {
    const steps = hostTourSteps();
    const selectors = steps.map((s) => s.selector).filter(Boolean);
    assert.deepEqual(selectors, [
      '[data-tour="host-tabs"]',
      '[data-tour="host-now"]',
      '[data-tour="host-songs"]',
      '[data-tour="host-share"]',
    ]);
    assert.ok(steps.some((s) => /did not sign up/i.test(s.body)));
    assert.ok(steps.some((s) => s.tab === 'settings'));
  });
});
