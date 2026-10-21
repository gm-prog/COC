import { describe, expect, it } from 'vitest';
import { Hud } from '../src/hud';
import { t } from '../src/i18n';

/**
 * The wall banner is the only place the game says "drag".
 *
 * It therefore has to survive the scene reporting that the pointer is off the
 * village — which happens the moment the shop closes under the cursor, and
 * again whenever the pointer leaves the canvas — without falling back to
 * "move over the village to preview placement", copy that describes a tap.
 *
 * A tiny fake root keeps the real rendering code under test without a browser;
 * the Playwright suite presses the actual controls.
 */

interface FakeNode {
  hidden: boolean;
  textContent: string;
  className: string;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  classList: { add: (name: string) => void; remove: (...names: string[]) => void };
  setAttribute: (name: string, value: string) => void;
}

function fakeNode(): FakeNode {
  const classes = new Set<string>();
  const node: FakeNode = {
    hidden: false,
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
  };
  return node;
}

const IDS = ['placement-banner', 'placement-title', 'placement-feedback', 'hud-hint'] as const;

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

describe('the placement banner in wall mode', () => {
  it('says "drag" both while idle and while the pointer is off the village', () => {
    const { hud, nodes } = fakeHud();

    hud.setPlacementMode('wall', { instructionsKey: 'placement.wallInstructions' });

    // Choosing the card leaves the cursor over the shop: the scene reports
    // "outside". That must not replace the drag copy with tap copy.
    hud.setPlacementFeedback('outside');
    expect(nodes['placement-feedback']!.textContent).toBe(t('placement.wallInstructions'));

    hud.setPlacementFeedback('none');
    expect(nodes['placement-feedback']!.textContent).toBe(t('placement.wallInstructions'));

    // A concrete tile still reports a result, not the instruction.
    hud.setPlacementFeedback('valid');
    expect(nodes['placement-feedback']!.textContent).toBe(t('placement.valid'));
    hud.setPlacementFeedback('invalid');
    expect(nodes['placement-feedback']!.textContent).toBe(t('placement.invalid'));
  });

  it('leaves the tap instructions alone for every other building', () => {
    const { hud, nodes } = fakeHud();

    hud.setPlacementMode('gold_mine');
    hud.setPlacementFeedback('none');
    expect(nodes['placement-feedback']!.textContent).toBe(t('placement.instructions'));

    hud.setPlacementFeedback('outside');
    expect(nodes['placement-feedback']!.textContent).toBe(t('placement.outside'));
  });

  it('forgets the drag copy when the mode changes or closes', () => {
    const { hud, nodes } = fakeHud();

    hud.setPlacementMode('wall', { instructionsKey: 'placement.wallInstructions' });
    hud.setPlacementMode(null);

    expect(nodes['placement-banner']!.hidden).toBe(true);

    // The next mode is an ordinary tap placement and must say so, even before
    // the pointer reaches a tile.
    hud.setPlacementMode('gold_mine');
    hud.setPlacementFeedback('outside');
    expect(nodes['placement-feedback']!.textContent).toBe(t('placement.outside'));
  });
});
