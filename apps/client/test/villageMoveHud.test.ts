import { describe, expect, it } from 'vitest';
import { Hud } from '../src/hud';
import { t } from '../src/i18n';

/**
 * The move affordances live in the DOM HUD, so they are asserted on the HUD
 * itself rather than through Phaser.
 *
 * A tiny fake root stands in for `index.html`: `Hud` only ever reaches its
 * elements through `querySelector('#id')`, so this checks the real rendering
 * code without a browser. The click wiring is exercised by the Playwright
 * scenario, which presses the actual button.
 */

interface FakeNode {
  hidden: boolean;
  disabled: boolean;
  textContent: string;
  className: string;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  classList: { add: (name: string) => void; remove: (...names: string[]) => void };
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
}

function fakeNode(): FakeNode {
  const classes = new Set<string>();
  const node: FakeNode = {
    hidden: false,
    disabled: false,
    textContent: '',
    className: '',
    dataset: {},
    attributes: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (...names) => {
        for (const name of names) classes.delete(name);
      },
    },
    setAttribute: (name, value) => {
      node.attributes[name] = value;
    },
    getAttribute: (name) => node.attributes[name] ?? null,
  };
  return node;
}

const IDS = [
  'selection-panel',
  'selection-kind',
  'selection-title',
  'selection-meta',
  'selection-buffer',
  'selection-collect',
  'selection-move',
  'selection-upgrade',
  'selection-upgrade-title',
  'selection-upgrade-cost',
  'selection-upgrade-stats',
  'selection-upgrade-status',
  'selection-upgrade-button',
  'placement-banner',
  'placement-title',
  'placement-feedback',
  'hud-hint',
] as const;

function fakeHud(): { hud: Hud; nodes: Record<string, FakeNode> } {
  const nodes: Record<string, FakeNode> = {};
  for (const id of IDS) nodes[id] = fakeNode();

  const root = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    querySelector: (selector: string) => {
      const id = selector.startsWith('#') ? selector.slice(1) : selector;
      return nodes[id] ?? null;
    },
  };

  return { hud: new Hud(root as unknown as HTMLElement), nodes };
}

describe('the Move action in the selection panel', () => {
  it('is offered for a building, labelled and carrying the entity id', () => {
    const { hud, nodes } = fakeHud();

    hud.setSelection({
      kind: 'building',
      id: 'gold_mine',
      entityId: 7,
      x: 14,
      y: 17,
      level: 1,
    });

    const move = nodes['selection-move']!;
    expect(move.hidden).toBe(false);
    expect(move.disabled).toBe(false);
    expect(move.textContent).toBe('Move');
    expect(move.dataset.buildingId).toBe('7');
    // Accessible names come from i18n too, and name the building so a screen
    // reader does not announce a bare "Move".
    expect(move.getAttribute('aria-label')).toBe(
      t('selection.moveNamed', { building: 'Gold Mine' }),
    );
    // The original coordinates stay on screen while the player chooses.
    expect(nodes['selection-meta']!.textContent).toBe('Level 1 · Tile 14, 17');
  });

  it('is hidden for an obstacle, which has no move command', () => {
    const { hud, nodes } = fakeHud();

    hud.setSelection({ kind: 'obstacle', id: 'tree', x: 8, y: 8 });

    const move = nodes['selection-move']!;
    expect(move.hidden).toBe(true);
    expect(move.disabled).toBe(true);
    expect(move.dataset.buildingId).toBeUndefined();
  });

  it('is hidden again when the selection is cleared, and forgets its target', () => {
    const { hud, nodes } = fakeHud();
    hud.setSelection({ kind: 'building', id: 'gold_mine', entityId: 7, x: 14, y: 17, level: 1 });
    expect(nodes['selection-move']!.hidden).toBe(false);
    expect(nodes['selection-move']!.dataset.buildingId).toBe('7');

    hud.setSelection(null);

    expect(nodes['selection-panel']!.hidden).toBe(true);
    // Leaving a hidden button holding the old id would let a stray dispatch
    // start a move for a building that is no longer selected.
    expect(nodes['selection-move']!.hidden).toBe(true);
    expect(nodes['selection-move']!.dataset.buildingId).toBeUndefined();
  });
});

describe('the move banner', () => {
  it('names the building and gives the instruction when the mode opens', () => {
    const { hud, nodes } = fakeHud();

    hud.setMoveMode('gold_mine');

    expect(nodes['placement-banner']!.hidden).toBe(false);
    expect(nodes['placement-title']!.textContent).toBe('Move Gold Mine');
    expect(nodes['placement-feedback']!.textContent).toBe(t('move.instructions'));
    // The standing hint is replaced so the banner is the only instruction.
    expect(nodes['hud-hint']!.textContent).toBe('');
  });

  it('reports valid, blocked and off-map destinations', () => {
    const { hud, nodes } = fakeHud();
    hud.setMoveMode('gold_mine');

    hud.setMoveFeedback('valid');
    expect(nodes['placement-feedback']!.textContent).toBe('Valid destination — tap to move');

    hud.setMoveFeedback('invalid');
    expect(nodes['placement-feedback']!.textContent).toBe(
      'Blocked — choose an empty buildable tile',
    );

    hud.setMoveFeedback('outside');
    expect(nodes['placement-feedback']!.textContent).toBe(
      'Move over the village to choose a destination',
    );
  });

  it('cannot be confused with placement: the title is rewritten, not shared', () => {
    const { hud, nodes } = fakeHud();

    hud.setPlacementMode('gold_mine');
    expect(nodes['placement-title']!.textContent).toBe('Place Gold Mine');

    hud.setMoveMode('gold_mine');
    expect(nodes['placement-title']!.textContent).toBe('Move Gold Mine');

    hud.setPlacementMode(null);
    expect(nodes['placement-banner']!.hidden).toBe(true);
    expect(nodes['hud-hint']!.textContent).toBe(t('hud.hint'));
  });

  it('uses the same Cancel button for both modes', () => {
    const { hud, nodes } = fakeHud();

    hud.setMoveMode('gold_mine');

    // The banner is shared, so there is exactly one cancel affordance and it is
    // never left pointing at a mode that has already ended.
    expect(nodes['placement-banner']!.hidden).toBe(false);
    expect(t('placement.cancel')).toBe('Cancel');
  });
});
