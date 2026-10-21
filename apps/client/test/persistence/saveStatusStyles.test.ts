import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The save-status pill is the only place a player learns that progress is not
 * being saved. Every such state must look the same, so a warning can never be
 * rendered in the neutral "everything is fine" styling by omission — which is
 * exactly what happened to `clock_behind` when it was added.
 */
const CSS = readFileSync(resolve(__dirname, '../../src/styles.css'), 'utf8');

/** States that mean "your progress is not durable". */
const WARNING_STATES = [
  'blocked',
  'unavailable',
  'unreadable',
  'incompatible',
  'clock_behind',
  'conflict',
] as const;

describe('save-status warning styling', () => {
  it('styles every non-durable state as a warning', () => {
    for (const state of WARNING_STATES) {
      const selector = `.hud__save-status[data-save-state='${state}']`;
      expect(CSS, `${state} has no save-status rule`).toContain(selector);
    }
  });

  it('groups them in one rule so they cannot drift apart', () => {
    // Find the rule that colours `blocked` and check the whole warning set is in
    // the same selector list.
    const ruleStart = CSS.indexOf(".hud__save-status[data-save-state='blocked']");
    expect(ruleStart).toBeGreaterThanOrEqual(0);
    const ruleEnd = CSS.indexOf('}', ruleStart);
    const selectorList = CSS.slice(ruleStart, ruleEnd);

    for (const state of WARNING_STATES) {
      expect(selectorList, `${state} is not styled with the other warnings`).toContain(
        `.hud__save-status[data-save-state='${state}']`,
      );
    }
    // And the rule actually sets a warning colour.
    expect(selectorList).toContain('var(--danger');
  });

  it('keeps the healthy states neutral', () => {
    for (const state of ['idle', 'saving', 'saved']) {
      expect(CSS).not.toContain(`.hud__save-status[data-save-state='${state}']`);
    }
  });
});
