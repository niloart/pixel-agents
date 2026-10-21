/**
 * The colorized-sprite cache is LRU-capped: slider drags mint a key per tick,
 * and each cached SpriteData pins per-zoom canvases, so it must not grow forever.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { FALLBACK_FLOOR_COLOR } from '../src/constants.js';
import {
  clearColorizeCache,
  getColorizedSprite,
  SPRITE_CACHE_MAX_ENTRIES,
} from '../src/office/colorize.js';
import { getColorizedFloorSprite } from '../src/office/floorTiles.js';

const SPRITE = [[FALLBACK_FLOOR_COLOR]];
const COLOR = { h: 0, s: 0, b: 0, c: 0 };

test('evicts the least-recently-used entry once the cap is exceeded', () => {
  clearColorizeCache();
  const first = getColorizedSprite('k0', SPRITE, COLOR);
  const second = getColorizedSprite('k1', SPRITE, COLOR);
  for (let i = 2; i < SPRITE_CACHE_MAX_ENTRIES; i++) getColorizedSprite(`k${i}`, SPRITE, COLOR);

  // Touch k0 so k1 becomes the oldest, then overflow by one.
  assert.equal(getColorizedSprite('k0', SPRITE, COLOR), first);
  getColorizedSprite('overflow', SPRITE, COLOR);

  assert.equal(getColorizedSprite('k0', SPRITE, COLOR), first, 'recently read entry survives');
  assert.notEqual(getColorizedSprite('k1', SPRITE, COLOR), second, 'oldest entry was evicted');
});

test('unknown floor pattern returns one shared error tile', () => {
  // Pattern 0 is never valid; the same instance keeps the per-zoom sprite cache hitting.
  assert.equal(getColorizedFloorSprite(0, COLOR), getColorizedFloorSprite(0, COLOR));
});
