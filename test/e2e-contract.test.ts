import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { t } from '../apps/client/src/i18n';
import { screenToTileFloor, TILE_HEIGHT, TILE_WIDTH } from '../apps/client/src/iso';
import {
  centerOnWorld,
  worldSizeForGrid,
  type CameraTransform,
} from '../apps/client/src/cameraTransform';
import { GRID } from '../packages/sim-core/src/config/geometry';
import { tileCenterToPage } from '../e2e/support/villageGeometry';

/**
 * Browser-free guards for the `e2e/*.spec.ts` suites.
 *
 * The Playwright suite needs a Chromium binary, which some environments cannot
 * provide (CI installs one; a locked-down sandbox may not). These tests cover
 * the two things that can break the browser test without the browser itself:
 *
 * 1. the tile → page coordinate maths, and
 * 2. the DOM ids, test ids and English strings the spec asserts against.
 *
 * They do **not** replace the browser test — only the browser proves Phaser's
 * canvas, the clock and the HUD behave together.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(`${repoRoot}${relative}`, 'utf8');

/** Every browser spec, so a new one cannot escape the contract checks below. */
const SPEC_FILES = [
  'e2e/phase3-village.spec.ts',
  'e2e/phase3-move-mode.spec.ts',
  'e2e/phase3-obstacle-removal.spec.ts',
  'e2e/phase3-wall-drag.spec.ts',
];

/** The fixed viewport from `playwright.config.ts`. */
const VIEWPORT = { width: 1280, height: 800 };
const WORLD = worldSizeForGrid(GRID.total, TILE_WIDTH, TILE_HEIGHT);

/** The camera `BootScene.recenter()` installs at boot: zoom 1, centred on the map. */
const BOOT_CAMERA: CameraTransform = centerOnWorld({
  viewWidth: VIEWPORT.width,
  viewHeight: VIEWPORT.height,
  worldWidth: WORLD.worldWidth,
  worldHeight: WORLD.worldHeight,
});

describe('browser test geometry: tile centres on the canvas', () => {
  const canvas = { x: 0, y: 0, ...VIEWPORT };

  it('maps the placement tile to the middle of the viewport', () => {
    // The smoke test places at (24, 24): the world origin lands on the screen
    // centre horizontally, so this tile is dead centre of a 1280×800 canvas.
    expect(tileCenterToPage(canvas, { x: 24, y: 24 })).toEqual({ x: 640, y: 416 });
  });

  it('keeps the camera the scene actually installs', () => {
    // centerOnWorld: panX = viewWidth/2; panY = viewHeight/2 − worldHeight/2.
    expect(BOOT_CAMERA).toEqual({ zoom: 1, panX: 640, panY: 400 - WORLD.worldHeight / 2 });
  });

  it('offsets every point by the canvas origin inside the page', () => {
    const offset = { x: 10, y: 20, ...VIEWPORT };
    expect(tileCenterToPage(offset, { x: 24, y: 24 })).toEqual({ x: 650, y: 436 });
  });

  it('round-trips every buildable tile through the game’s own inverse projection', () => {
    // Phaser turns a pointer position into a tile with exactly this path:
    // screen − pan, then screenToTileFloor. Every buildable tile centre must
    // land back on the tile it started from, or a click would place elsewhere.
    // Not every tile is on screen at this viewport (the map is 48×48 and the
    // camera can pan), so visibility is asserted separately below.
    for (let x = GRID.margin; x < GRID.margin + GRID.buildable; x += 1) {
      for (let y = GRID.margin; y < GRID.margin + GRID.buildable; y += 1) {
        const point = tileCenterToPage(canvas, { x, y });
        const tile = screenToTileFloor(point.x - BOOT_CAMERA.panX, point.y - BOOT_CAMERA.panY);
        expect(tile, `tile ${x},${y} → page ${point.x},${point.y}`).toEqual({ x, y });
      }
    }
  });

  it('keeps the obstacle the browser test clears clear of the HUD chrome', () => {
    // The obstacle spec taps the starter rock at (6, 20). The top-left overlay
    // holds the title badge and the Build button, the only interactive elements
    // up there; the tile centre has to land below and clear of them.
    const point = tileCenterToPage(canvas, { x: 6, y: 20 });
    expect(point.x).toBeGreaterThan(180);
    expect(point.y).toBeGreaterThan(48);
    expect(point.x).toBeLessThan(VIEWPORT.width - 12);
    expect(point.y).toBeLessThan(VIEWPORT.height - 12);
  });

  /**
   * The wall suite drags along row y = 26, and probes the camera at (30, 30).
   *
   * Those points must be on screen and must not fall inside a panel that takes
   * clicks back from the canvas: the shop (top-right), the placement banner
   * (bottom-right) and the selection panel (bottom-left). The village panel is
   * `pointer-events: none`, so it cannot swallow a drag.
   */
  it('keeps the wall-drag row and the camera probe clear of clickable panels', () => {
    const wallTiles = [
      { x: 14, y: 26 },
      { x: 15, y: 26 },
      { x: 16, y: 26 },
      { x: 17, y: 26 },
      { x: 18, y: 26 },
      { x: 19, y: 26 },
      { x: 30, y: 30 },
    ];

    for (const tile of wallTiles) {
      const point = tileCenterToPage(canvas, tile);
      expect(point.x).toBeGreaterThan(12);
      expect(point.x).toBeLessThan(VIEWPORT.width - 12);
      expect(point.y).toBeGreaterThan(48);
      expect(point.y).toBeLessThan(VIEWPORT.height - 12);

      const inShop = point.x > 908 && point.y < 700;
      const inBanner = point.x > 908 && point.y > 640;
      const inSelectionPanel = point.x < 292 && point.y > 500;
      expect(
        inShop || inBanner || inSelectionPanel,
        `tile ${tile.x},${tile.y} lands on clickable chrome at ${point.x},${point.y}`,
      ).toBe(false);
    }
  });

  it('keeps the placement tile and its neighbours on screen', () => {
    // The tile the smoke test clicks, plus the 3×3 footprint it occupies, must
    // be inside the viewport and clear of the HUD panels. The HUD lives at the
    // top-left banner, the top-right shop, and the bottom third; (24, 24) lands
    // in the middle, which is why it was chosen.
    for (let x = 24; x <= 26; x += 1) {
      for (let y = 24; y <= 26; y += 1) {
        const point = tileCenterToPage(canvas, { x, y });
        expect(point.x).toBeGreaterThan(320);
        expect(point.x).toBeLessThan(960);
        expect(point.y).toBeGreaterThan(200);
        expect(point.y).toBeLessThan(700);
      }
    }
  });
});

describe('browser test contract: DOM hooks and copy', () => {
  const spec = SPEC_FILES.map(read).join('\n');
  const html = read('apps/client/index.html');
  const hudSource = read('apps/client/src/hud.ts');

  const specIds = new Set([...spec.matchAll(/locator\('#([a-zA-Z0-9_-]+)/g)].map((m) => m[1]));
  const specTestIds = new Set(
    [...spec.matchAll(/getByTestId\('([a-zA-Z0-9_-]+)'\)/g)].map((m) => m[1]),
  );

  it('finds the selectors it is supposed to check', () => {
    // Guards the extractors above: an empty set would make the checks vacuous.
    expect(specIds.size).toBeGreaterThanOrEqual(15);
    expect(specTestIds.size).toBeGreaterThanOrEqual(5);
    // The move spec really is in the set, not silently missing: it is the only
    // one that presses the banner's Cancel button and the selection panel's
    // Move action.
    expect(specIds).toContain('placement-cancel');
    expect(specTestIds).toContain('selection-move');
    // And the obstacle spec: it is the only one that reads the reward preview.
    expect(specIds).toContain('selection-reward');
    expect(specTestIds).toContain('selection-remove');
    // And the wall spec: it is the only one that reads the drag instructions.
    expect(specIds).toContain('placement-feedback');
    expect(specTestIds).toContain('shop-item-wall');
  });

  it('references only ids that exist in index.html', () => {
    for (const id of specIds) {
      expect(html, `#${id} is missing from apps/client/index.html`).toContain(`id="${id}"`);
    }
  });

  it('references only test ids that exist in index.html or are generated by the HUD', () => {
    for (const testId of specTestIds) {
      if (html.includes(`data-testid="${testId}"`)) continue;
      // The shop cards are built at runtime: `shop-item-<building id>`.
      expect(testId.startsWith('shop-item-'), `unknown test id ${testId}`).toBe(true);
      expect(hudSource).toContain(`'shop-item-' + item.id`);
    }
  });

  it('asserts strings that the i18n dictionary actually produces', () => {
    // Every user-visible string the browser test matches, rendered from en.json.
    // A wording change fails here instead of in a browser run.
    expect(t('shop.title')).toBe('Build');
    expect(t('building.gold_mine')).toBe('Gold Mine');
    expect(t('shop.selectNamed', { building: t('building.gold_mine') })).toBe('Choose Gold Mine');
    expect(t('shop.size', { width: 3, height: 3 })).toBe('3×3 tiles');
    expect(t('shop.seconds', { seconds: 20 })).toBe('20s');
    expect(t('resource.gold')).toBe('Gold');
    expect(t('placement.title', { building: t('building.gold_mine') })).toBe('Place Gold Mine');
    expect(t('placement.valid')).toBe('Valid spot');
    expect(t('hud.zoneBuildable')).toBe('Buildable');
    expect(t('selection.meta.building', { level: 1, x: 24, y: 24 })).toBe('Level 1 · Tile 24, 24');
    expect(t('selection.buffer', { amount: 4, resource: t('resource.gold') })).toBe(
      'Stored: 4 Gold',
    );
    expect(t('selection.collectNamed', { amount: 4, resource: t('resource.gold') })).toBe(
      'Collect 4 Gold',
    );
    expect(t('upgrade.nextLevel', { level: 2 })).toBe('Next: level 2');
    expect(t('upgrade.costAndTime', { cost: '230 Gold', duration: '32s' })).toBe(
      'Cost: 230 Gold · Time: 32s',
    );
    expect(t('upgrade.available')).toBe('Ready to upgrade');
    expect(t('upgrade.inProgress', { level: 2 })).toBe('Upgrading to level 2');
    expect(t('upgrade.remaining', { duration: '32s' })).toBe('Time remaining: 32s');
    expect(t('upgrade.working')).toBe('Your builder is working on this building.');
    expect(t('upgrade.keepLevel', { level: 2 })).toBe('Requires Keep level 2');
    expect(t('builders.available', { available: 2, total: 2 })).toBe('2 / 2 available');
    expect(t('resource.amountCapacity', { amount: 1000, capacity: 1000 })).toBe('1000 / 1000');
    // Move Mode (e2e/phase3-move-mode.spec.ts), which moves the starter well.
    expect(t('building.essence_well')).toBe('Essence Well');
    expect(t('selection.move')).toBe('Move');
    expect(t('selection.moveNamed', { building: t('building.essence_well') })).toBe(
      'Move Essence Well',
    );
    expect(t('move.title', { building: t('building.essence_well') })).toBe('Move Essence Well');
    expect(t('move.instructions')).toBe('Tap a buildable tile to place this building there.');
    expect(t('move.valid')).toBe('Valid destination — tap to move');
    expect(t('move.invalid')).toBe('Blocked — choose an empty buildable tile');
    expect(t('move.done', { building: t('building.essence_well'), x: 24, y: 24 })).toBe(
      'Moved Essence Well to 24, 24.',
    );
    expect(t('move.noop')).toBe('That building is already there. Pick a different tile or cancel.');
    // Obstacle removal (e2e/phase3-obstacle-removal.spec.ts), which clears the
    // starter rock at (6, 20) while Gold is at its cap.
    expect(t('obstacle.rock')).toBe('Rock');
    expect(t('selection.remove')).toBe('Remove');
    expect(t('selection.removeNamed', { obstacle: t('obstacle.rock') })).toBe('Remove Rock');
    expect(t('obstacle.rewardCapped', { reward: '30 Gold · 1 Gems' })).toBe(
      'Reward: 30 Gold · 1 Gems · overflow is lost when storage is full',
    );
    expect(
      t('obstacle.removedPartial', { obstacle: 'Rock', credited: '1 Gems', lost: '30 Gold' }),
    ).toBe('Rock cleared: 1 Gems; 30 Gold was lost to storage.');
    expect(t('obstacle.removedNothing', { obstacle: 'Rock', lost: '30 Gold' })).toBe(
      'Rock cleared, but nothing fit in storage — 30 Gold was lost.',
    );
    // Drag-to-place walls (e2e/phase3-wall-drag.spec.ts), which draws two
    // segments at Keep 2 and then meets the two-builder limit.
    expect(t('shop.requiredKeep', { level: 2 })).toBe('Keep 2 required');
    expect(t('placement.title', { building: t('building.wall') })).toBe('Place Wall');
    expect(t('placement.wallInstructions')).toBe(
      'Drag across tiles to place a wall line, or tap a single tile. Release to build. Cancel first to pan by dragging.',
    );
    expect(t('placement.valid')).toBe('Valid spot');
    expect(t('wall.placed', { count: 2 })).toBe('Placed 2 wall segments.');
    expect(t('wall.placedOne')).toBe('Placed a wall segment.');
    expect(t('wall.partial', { count: 2, reason: t('wall.reason.builders') })).toBe(
      'Placed 2 wall segments, then stopped: all builders are busy.',
    );
    expect(t('wall.partialOne', { reason: t('wall.reason.blocked') })).toBe(
      'Placed a wall segment, then stopped: that tile is already taken.',
    );
    expect(t('wall.failed', { reason: t('wall.reason.margin') })).toBe(
      'No wall placed: that tile is in the decorative margin.',
    );
  });
});
