import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '@coc/game-data';
import { Hud } from '../src/hud';
import { t, type TranslationKey } from '../src/i18n';

/**
 * The obstacle affordances are DOM, so they are asserted on the real `Hud`.
 *
 * `index.html` is not loaded here; a minimal fake root stands in for it. `Hud`
 * only reaches its elements through `querySelector('#id')` and attaches one
 * delegated `click` listener, so the same code that runs in the browser runs
 * here — including the `data-*` plumbing that decides which entity is acted on.
 *
 * `Hud`'s click handler checks `event.target instanceof Element`. Node has no
 * `Element`, so the test installs a minimal one and restores it afterwards
 * rather than skipping the dispatch path, which is exactly the code that could
 * pass the wrong id.
 */

class FakeElement {
  closest(selector: string): FakeActionElement | null {
    void selector;
    return this instanceof FakeActionElement ? this : null;
  }
}

class FakeActionElement extends FakeElement {
  dataset: Record<string, string>;
  constructor(dataset: Record<string, string>) {
    super();
    this.dataset = dataset;
  }
}

interface FakeNode {
  hidden: boolean;
  disabled: boolean;
  textContent: string;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  classList: { add: (name: string) => void; remove: (...names: string[]) => void };
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
}

function fakeNode(): FakeNode {
  const node: FakeNode = {
    hidden: false,
    disabled: false,
    textContent: '',
    dataset: {},
    attributes: {},
    classList: { add: () => {}, remove: () => {} },
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
  'selection-remove',
  'selection-reward',
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

type ClickHandler = (event: unknown) => void;

function fakeHud(): {
  hud: Hud;
  nodes: Record<string, FakeNode>;
  click: (dataset: Record<string, string>) => void;
} {
  const nodes: Record<string, FakeNode> = {};
  for (const id of IDS) nodes[id] = fakeNode();

  let handler: ClickHandler | null = null;
  const root = {
    addEventListener: (type: string, listener: ClickHandler) => {
      if (type === 'click') handler = listener;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    contains: () => true,
    querySelector: (selector: string) => {
      const id = selector.startsWith('#') ? selector.slice(1) : selector;
      return nodes[id] ?? null;
    },
  };

  return {
    hud: new Hud(root as unknown as HTMLElement),
    nodes,
    click: (dataset) => {
      if (!handler) throw new Error('the HUD attached no click listener');
      handler({ target: new FakeActionElement(dataset) });
    },
  };
}

/** A selected rock: instance 5, the starter's rock at (6, 20). */
const ROCK = {
  kind: 'obstacle' as const,
  id: 'rock',
  entityId: 5,
  x: 6,
  y: 20,
  reward: { gold: 30, gems: 1 },
  rewardCapped: true,
};

/** A selected tree: instance 4, at (8, 8). */
const TREE = {
  kind: 'obstacle' as const,
  id: 'tree',
  entityId: 4,
  x: 8,
  y: 8,
  reward: { gold: 20 },
  rewardCapped: true,
};

const GOLD_MINE = {
  kind: 'building' as const,
  id: 'gold_mine',
  entityId: 2,
  x: 14,
  y: 17,
  level: 1,
};

let realElement: unknown;

beforeAll(() => {
  realElement = (globalThis as { Element?: unknown }).Element;
  (globalThis as { Element?: unknown }).Element = FakeElement;
});

afterAll(() => {
  (globalThis as { Element?: unknown }).Element = realElement;
});

describe('the Remove action', () => {
  it('is offered for a selected rock, labelled with the obstacle’s name', () => {
    const { hud, nodes } = fakeHud();

    hud.setSelection(ROCK);

    const remove = nodes['selection-remove']!;
    expect(remove.hidden).toBe(false);
    expect(remove.disabled).toBe(false);
    expect(remove.textContent).toBe(t('selection.remove'));
    expect(remove.getAttribute('aria-label')).toBe('Remove Rock');
    // The instance id, so the command acts on this rock and not another one.
    expect(remove.dataset.obstacleId).toBe('5');
  });

  it('is offered for a selected tree, and the ids differ per instance', () => {
    const { hud, nodes } = fakeHud();

    hud.setSelection(TREE);
    expect(nodes['selection-remove']!.getAttribute('aria-label')).toBe('Remove Tree');
    expect(nodes['selection-remove']!.dataset.obstacleId).toBe('4');

    hud.setSelection(ROCK);
    expect(nodes['selection-remove']!.dataset.obstacleId).toBe('5');
  });

  it('is hidden for a building, which keeps its own actions instead', () => {
    const { hud, nodes } = fakeHud();

    hud.setSelection(GOLD_MINE);

    expect(nodes['selection-remove']!.hidden).toBe(true);
    expect(nodes['selection-remove']!.disabled).toBe(true);
    expect(nodes['selection-remove']!.dataset.obstacleId).toBeUndefined();
    // The building's own actions are unaffected by the obstacle feature.
    expect(nodes['selection-move']!.hidden).toBe(false);
    expect(nodes['selection-move']!.dataset.buildingId).toBe('2');
  });

  it('is hidden for an obstacle while Move stays hidden on it', () => {
    const { hud, nodes } = fakeHud();

    hud.setSelection(ROCK);

    expect(nodes['selection-remove']!.hidden).toBe(false);
    // A rock is not a building: Move must never appear for it.
    expect(nodes['selection-move']!.hidden).toBe(true);
    expect(nodes['selection-move']!.dataset.buildingId).toBeUndefined();
  });

  it('is retired when the selection clears, without disturbing the others', () => {
    const { hud, nodes } = fakeHud();
    hud.setSelection(ROCK);
    hud.setSelection(GOLD_MINE);
    expect(nodes['selection-move']!.hidden).toBe(false);

    hud.setSelection(null);

    expect(nodes['selection-panel']!.hidden).toBe(true);
    expect(nodes['selection-remove']!.hidden).toBe(true);
    expect(nodes['selection-remove']!.dataset.obstacleId).toBeUndefined();
    expect(nodes['selection-move']!.hidden).toBe(true);
    expect(nodes['selection-move']!.dataset.buildingId).toBeUndefined();
    expect(nodes['selection-reward']!.hidden).toBe(true);
    expect(nodes['selection-reward']!.textContent).toBe('');
  });
});

describe('the reward preview', () => {
  it('shows the configured reward and warns that overflow is lost', () => {
    const { hud, nodes } = fakeHud();

    hud.setSelection(ROCK);

    expect(nodes['selection-reward']!.hidden).toBe(false);
    expect(nodes['selection-reward']!.textContent).toBe(
      'Reward: 30 Gold · 1 Gems · overflow is lost when storage is full',
    );
  });

  it('omits the capacity warning when nothing in the reward is capped', () => {
    const { hud, nodes } = fakeHud();

    hud.setSelection({ ...ROCK, id: 'rock', reward: { gems: 1 }, rewardCapped: false });

    expect(nodes['selection-reward']!.textContent).toBe('Reward: 1 Gems');
  });

  it('is hidden for buildings', () => {
    const { hud, nodes } = fakeHud();

    hud.setSelection(GOLD_MINE);

    expect(nodes['selection-reward']!.hidden).toBe(true);
    expect(nodes['selection-reward']!.textContent).toBe('');
  });
});

describe('dispatching the action', () => {
  it('passes the instance id the panel stored, not the type or the tile', () => {
    const { hud, nodes, click } = fakeHud();
    const received: number[] = [];
    hud.setShopHandlers({
      onSelectBuilding: () => {},
      onCancelPlacement: () => {},
      onCollectResource: () => {},
      onStartUpgrade: () => {},
      onMoveBuilding: () => {},
      onRemoveObstacle: (id) => received.push(id),
    });

    // Select one obstacle, then click exactly what the panel would send: this
    // chains selection → dataset → dispatch, so a hard-coded id cannot pass.
    hud.setSelection(ROCK);
    click({ hudAction: 'remove-obstacle', ...nodes['selection-remove']!.dataset });

    hud.setSelection(TREE);
    click({ hudAction: 'remove-obstacle', ...nodes['selection-remove']!.dataset });

    // Two rocks/trees with the same type resolve to two different instances.
    expect(received).toEqual([5, 4]);
  });

  it('ignores a malformed target instead of commanding id 0 or NaN', () => {
    const { hud, click } = fakeHud();
    const received: number[] = [];
    hud.setShopHandlers({
      onSelectBuilding: () => {},
      onCancelPlacement: () => {},
      onCollectResource: () => {},
      onStartUpgrade: () => {},
      onMoveBuilding: () => {},
      onRemoveObstacle: (id) => received.push(id),
    });

    click({ hudAction: 'remove-obstacle' });
    click({ hudAction: 'remove-obstacle', obstacleId: '' });
    click({ hudAction: 'remove-obstacle', obstacleId: 'abc' });
    click({ hudAction: 'remove-obstacle', obstacleId: '0' });

    expect(received).toEqual([]);
  });

  it('never routes a removal to the building actions', () => {
    const { hud, click } = fakeHud();
    const calls: string[] = [];
    hud.setShopHandlers({
      onSelectBuilding: () => calls.push('select'),
      onCancelPlacement: () => calls.push('cancel'),
      onCollectResource: () => calls.push('collect'),
      onStartUpgrade: () => calls.push('upgrade'),
      onMoveBuilding: () => calls.push('move'),
      onRemoveObstacle: () => calls.push('remove'),
    });

    click({ hudAction: 'remove-obstacle', obstacleId: '5' });
    click({ hudAction: 'move-building', buildingId: '2' });

    expect(calls).toEqual(['remove', 'move']);
  });
});

describe('the i18n copy the action renders', () => {
  it('resolves every key this feature adds', () => {
    expect(t('selection.remove')).toBe('Remove');
    expect(t('selection.removeNamed', { obstacle: t('obstacle.tree') })).toBe('Remove Tree');
    expect(t('obstacle.reward', { reward: '20 Gold' })).toBe('Reward: 20 Gold');
    expect(t('obstacle.removeFailed')).toBe(
      'That obstacle could not be removed. Nothing has changed.',
    );
    // The obstacle names are the config ids, not ad-hoc strings.
    for (const def of GAME_CONFIG.obstacles) {
      const name = t(('obstacle.' + def.id) as TranslationKey);
      expect(name, def.id).not.toBe('obstacle.' + def.id);
    }
  });
});
