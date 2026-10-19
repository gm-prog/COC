import { describe, expect, it } from 'vitest';
import { CONFIG_VERSION, RESOURCE_IDS } from '../src/index';

describe('game-data', () => {
  it('exposes a semantic config version', () => {
    expect(CONFIG_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('defines the four resources from the design spec', () => {
    expect([...RESOURCE_IDS]).toEqual(['gold', 'essence', 'shards', 'gems']);
  });
});
