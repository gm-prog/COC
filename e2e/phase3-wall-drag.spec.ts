import { expect, test, type Page } from '@playwright/test';
import { collectBrowserErrors } from './support/browserErrors';
import { canvasBox, tileCenterToPage, type Tile } from './support/villageGeometry';
import { keepTwoSave } from './support/keepTwoVillage';

/**
 * Phase 3 browser test: drag-to-place walls (Gate C item 7).
 *
 * Everything is driven through the UI: open the Build shop, look at the Wall
 * card, choose it, drag real mouse events across the canvas, read the HUD's own
 * report, wait for the save indicator, reload, and inspect the village again.
 * Nothing reaches into the Phaser scene or mutates `PlayerState` directly.
 *
 * ## The two villages this suite needs
 *
 * - **Keep 1** is the configured starter, and it must keep refusing walls:
 *   `buildings.json` unlocks them at Keep 2 and `limits.json` allows 0 walls at
 *   Keep 1. Scenario A proves the gate still holds rather than weakening it.
 * - **Keep 2** is seeded as a test-only save (`support/keepTwoVillage.ts`) and
 *   restored through the ordinary `bootstrapVillage` path after a reload. That
 *   is a fixture, not proof that a player can reach Keep 2 — Gate C item 18
 *   stays open.
 *
 * ## Why the strokes stop after two segments
 *
 * D27 makes every wall an ordinary construction: 10 Gold and one builder for 5
 * seconds. Two builders therefore allow exactly two segments per burst. The
 * drag in scenario B is four tiles long on purpose, so the suite proves the
 * honest behaviour — place the accepted prefix, stop at the first refusal,
 * explain why — instead of a wall line the rules would never allow.
 */

/** Fixed wall clock for every scenario. */
const START_TIME = new Date('2026-01-01T00:00:00.000Z');

/** Simulated time that covers the autosave debounce (400 ms) with margin. */
const SAVE_DEBOUNCE_MS = 1_000;
/** One frame's worth of simulated time, enough for Phaser to process input. */
const FRAME_MS = 120;
/** Wall level 1: 5 s of construction, so 6 s frees both builders. */
const WALL_FINISH_MS = 6_000;

/** Gold is capped at 1,600 once the Keep is level 2. */
const KEEP_TWO_GOLD = '1000 / 1600';

/** A horizontal line at y = 26: clear of the Keep, both mines and all obstacles. */
const FIRST_STROKE: Tile[] = [
  { x: 14, y: 26 },
  { x: 15, y: 26 },
  { x: 16, y: 26 },
  { x: 17, y: 26 },
];

/** Continues the line; drawn after the first two segments finish building. */
const SECOND_STROKE: Tile[] = [
  { x: 18, y: 26 },
  { x: 19, y: 26 },
];

/** A point far from every HUD panel, used to prove the camera did (not) move. */
const CAMERA_PROBE: Tile = { x: 30, y: 30 };

/** Pins the clock a little ahead of now, absorbing round-trip latency. */
async function freezeClock(page: Page): Promise<void> {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(now + 2_000));
}

/** One burst of frames so Phaser dispatches queued pointer events. */
async function settle(page: Page): Promise<void> {
  await page.clock.runFor(FRAME_MS);
}

async function canvasPoint(page: Page, tile: Tile): Promise<{ x: number; y: number }> {
  return tileCenterToPage(await canvasBox(page), tile);
}

/** Moves the pointer onto a tile and lets the HUD's readout catch up. */
async function hoverTile(page: Page, tile: Tile): Promise<void> {
  const point = await canvasPoint(page, tile);
  await page.mouse.move(point.x, point.y);
  await settle(page);
  await expect(page.getByTestId('tile')).toHaveText(`${tile.x}, ${tile.y}`);
}

/**
 * One real mouse drag through the given tile centres.
 *
 * Each hop uses several `mouse.move` steps, so the canvas receives a burst of
 * sampled positions rather than a single lucky jump: the client has to
 * interpolate the cells between samples for the stroke to be contiguous.
 */
async function dragTiles(page: Page, tiles: Tile[]): Promise<void> {
  const first = tiles[0];
  if (!first) throw new Error('dragTiles needs at least one tile');

  const start = await canvasPoint(page, first);
  await page.mouse.move(start.x, start.y);
  await settle(page);
  await page.mouse.down();
  await settle(page);

  for (const tile of tiles.slice(1)) {
    const point = await canvasPoint(page, tile);
    await page.mouse.move(point.x, point.y, { steps: 4 });
    await settle(page);
  }

  await page.mouse.up();
  await settle(page);
}

/** Presses and releases on one tile, as a player inspecting the village would. */
async function tapTile(page: Page, tile: Tile): Promise<void> {
  const point = await canvasPoint(page, tile);
  await page.mouse.move(point.x, point.y);
  await settle(page);
  await page.mouse.down();
  await settle(page);
  await page.mouse.up();
  await settle(page);
}

/** Opens the Build shop and returns the Wall card's own controls. */
async function openWallCard(page: Page) {
  await page.getByRole('button', { name: 'Build', exact: true }).click();
  const card = page.getByTestId('shop-item-wall');
  await expect(card).toBeVisible();
  return {
    card,
    choose: card.getByRole('button', { name: 'Choose Wall' }),
  };
}

/** Reads the committed record's revision straight from IndexedDB. */
async function storedRevision(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('emberhold');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const record = await new Promise<{ revision?: number } | undefined>((resolve, reject) => {
        const tx = database.transaction('village', 'readonly');
        const request = tx.objectStore('village').get('current');
        request.onsuccess = () => resolve(request.result as { revision?: number } | undefined);
        request.onerror = () => reject(request.error);
      });
      return record?.revision ?? -1;
    } finally {
      database.close();
    }
  });
}

/**
 * Waits until a commit newer than `previous` is in IndexedDB.
 *
 * `expect.poll` runs its interval in Node, so it keeps retrying while the
 * page's clock is paused; a web-first assertion would be waiting for animation
 * frames that the paused clock never runs, and a save that landed a moment late
 * would hang the test instead of retrying.
 */
async function waitForRevisionAfter(page: Page, previous: number): Promise<number> {
  await expect.poll(() => storedRevision(page), { timeout: 20_000 }).toBeGreaterThan(previous);
  return storedRevision(page);
}

/**
 * Boots a fresh page, waits for the starter's first committed save, then
 * replaces the record with a Keep 2 fixture and reloads.
 *
 * Writing a valid record and reloading is the only way in: the app restores it
 * through `bootstrapVillage`, validates it exactly as it validates a player's
 * own save, and never learns that it came from a test. An invalid fixture would
 * restore as an unreadable save, and the gold/capacity assertions below would
 * fail loudly instead of the drag quietly testing the wrong village.
 */
async function loadKeepTwoVillage(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#game canvas')).toBeVisible();
  await freezeClock(page);

  // The starter is persisted immediately on first boot; wait for the commit, so
  // the overwrite below cannot race a pending write.
  await page.clock.runFor(SAVE_DEBOUNCE_MS);
  await waitForRevisionAfter(page, 0);

  const now = await page.evaluate(() => Date.now());
  const save = keepTwoSave(now);
  await page.evaluate(async (record) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('emberhold');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction('village', 'readwrite');
        tx.objectStore('village').put(record, 'current');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      database.close();
    }
  }, save);

  await page.reload();
  await expect(page.locator('#game canvas')).toBeVisible();
  await expect(page.locator('#resource-gold-value')).toHaveText(KEEP_TWO_GOLD);
  await expect(page.locator('#builders-count')).toHaveText('2 / 2 available');
}

test('walls stay locked at Keep 1, and a drag cannot sneak one in', async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);

  await page.clock.install({ time: START_TIME });
  await page.goto('/');
  await expect(page.locator('#game canvas')).toBeVisible();
  await expect(page.locator('#resource-gold-value')).toHaveText('1000 / 1000');
  await freezeClock(page);

  await page.clock.runFor(SAVE_DEBOUNCE_MS);
  await waitForRevisionAfter(page, 0);
  const revisionBefore = await storedRevision(page);

  // 1. The shop still refuses Wall at Keep 1, with the configured reason.
  const { card, choose } = await openWallCard(page);
  await expect(choose).toBeDisabled();
  await expect(card.locator('.shop-item__reason')).toHaveText('Keep 2 required');
  await expect(card.locator('.shop-item__heading')).toContainText('1×1 tiles');
  await expect(card.locator('.shop-item__details')).toHaveText('10 Gold · 5s');

  // 2. Neither a tap nor a drag can start wall placement: no banner appears,
  //    nothing is spent, no builder is taken and no save is queued.
  await page.keyboard.press('Escape');
  await expect(page.locator('#shop-panel')).toBeHidden();
  await dragTiles(page, [
    { x: 10, y: 26 },
    { x: 11, y: 26 },
    { x: 12, y: 26 },
  ]);

  await expect(page.locator('#placement-banner')).toBeHidden();
  await expect(page.locator('#resource-gold-value')).toHaveText('1000 / 1000');
  await expect(page.locator('#builders-count')).toHaveText('2 / 2 available');
  await expect(page.locator('#builder-countdowns')).toBeHidden();

  await page.clock.runFor(SAVE_DEBOUNCE_MS);
  expect(await storedRevision(page)).toBe(revisionBefore);

  browserErrors.expectNone('the locked-wall scenario');
});

test('a wall line is dragged, saved and restored; mode stays open', async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);

  await page.clock.install({ time: START_TIME });
  await loadKeepTwoVillage(page);
  const revisionAtLoad = await storedRevision(page);

  // 1. Wall is available at Keep 2, and choosing it opens the drag banner.
  const { choose } = await openWallCard(page);
  await expect(choose).toBeEnabled();
  await choose.click();

  await expect(page.locator('#placement-banner')).toBeVisible();
  await expect(page.locator('#placement-title')).toHaveText('Place Wall');
  await expect(page.locator('#placement-feedback')).toHaveText(
    'Drag across tiles to place a wall line, or tap a single tile. Release to build. Cancel first to pan by dragging.',
  );

  // 2. The 1×1 preview follows the pointer before the drag starts.
  await hoverTile(page, FIRST_STROKE[0]!);
  await expect(page.locator('#placement-feedback')).toHaveText('Valid spot');

  // 3. A four-tile drag, sampled in several steps per hop. Two builders mean the
  //    command accepts two segments and refuses the third.
  await dragTiles(page, FIRST_STROKE);

  await expect(page.locator('#resource-gold-value')).toHaveText('980 / 1600');
  await expect(page.locator('#builders-count')).toHaveText('0 / 2 available');
  await expect(page.locator('#builder-countdowns')).toContainText('Wall');
  await expect(page.getByTestId('hint')).toHaveText(
    'Placed 2 wall segments, then stopped: all builders are busy.',
  );
  // Wall mode is still open for the next line, with its own instructions back.
  await expect(page.locator('#placement-banner')).toBeVisible();
  await expect(page.locator('#placement-title')).toHaveText('Place Wall');
  await expect(page.locator('#placement-feedback')).toHaveText(
    'Drag across tiles to place a wall line, or tap a single tile. Release to build. Cancel first to pan by dragging.',
  );

  // 4. The stroke did not pan the camera. The probe tile is far from every
  //    panel; if the drag had panned, this page point would report another tile.
  await hoverTile(page, CAMERA_PROBE);

  // 5. Builders finish, and a second stroke needs no trip back to the shop.
  await page.clock.runFor(WALL_FINISH_MS);
  await settle(page);
  await expect(page.locator('#builders-count')).toHaveText('2 / 2 available');
  await dragTiles(page, SECOND_STROKE);

  await expect(page.locator('#resource-gold-value')).toHaveText('960 / 1600');
  await expect(page.locator('#builders-count')).toHaveText('0 / 2 available');
  await expect(page.getByTestId('hint')).toHaveText('Placed 2 wall segments.');
  await expect(page.locator('#placement-banner')).toBeVisible();

  // 6. Let both walls finish, wait for the write to commit, then reload.
  await page.clock.runFor(WALL_FINISH_MS);
  await settle(page);
  await expect(page.locator('#builders-count')).toHaveText('2 / 2 available');
  await page.clock.runFor(SAVE_DEBOUNCE_MS);
  await waitForRevisionAfter(page, revisionAtLoad);

  await page.reload();
  await expect(page.locator('#game canvas')).toBeVisible();
  await expect(page.locator('#resource-gold-value')).toHaveText('960 / 1600');
  await expect(page.locator('#builders-count')).toHaveText('2 / 2 available');

  // 7. The four accepted cells came back as level-1 walls; the cells the stroke
  //    never reached are still empty. Tapping one of those hides the panel.
  for (const tile of [...FIRST_STROKE.slice(0, 2), ...SECOND_STROKE]) {
    await tapTile(page, tile);
    await expect(page.locator('#selection-title')).toHaveText('Wall');
    await expect(page.locator('#selection-meta')).toHaveText(`Level 1 · Tile ${tile.x}, ${tile.y}`);
  }

  await tapTile(page, { x: 16, y: 26 });
  await expect(page.getByTestId('selection-panel')).toBeHidden();

  browserErrors.expectNone('the wall drag, save and reload journey');
});

test('cancel, a blocked tile and a duplicate crossing all behave honestly', async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);

  await page.clock.install({ time: START_TIME });
  await loadKeepTwoVillage(page);

  // 1. Escape while the drag is still down: the draft dies, nothing is spent,
  //    and no revision is written. A restored village has nothing to save yet,
  //    so the indicator stays idle; the revision is read straight from the
  //    record the fixture wrote.
  await page.clock.runFor(SAVE_DEBOUNCE_MS);
  const revisionBefore = await storedRevision(page);
  expect(revisionBefore).toBe(1);

  const { choose } = await openWallCard(page);
  await choose.click();

  const start = await canvasPoint(page, { x: 14, y: 28 });
  await page.mouse.move(start.x, start.y);
  await settle(page);
  await page.mouse.down();
  await settle(page);
  const next = await canvasPoint(page, { x: 15, y: 28 });
  await page.mouse.move(next.x, next.y, { steps: 4 });
  await settle(page);
  await page.keyboard.press('Escape');
  await settle(page);
  await page.mouse.up();
  await settle(page);

  await expect(page.locator('#placement-banner')).toBeHidden();
  await expect(page.locator('#resource-gold-value')).toHaveText(KEEP_TWO_GOLD);
  await expect(page.locator('#builders-count')).toHaveText('2 / 2 available');
  await page.clock.runFor(SAVE_DEBOUNCE_MS);
  expect(await storedRevision(page)).toBe(revisionBefore);

  // 2. A stroke that begins on the Keep is refused at its very first cell: the
  //    state, the mode and the hint all say so, and nothing is saved.
  const blocked = await openWallCard(page);
  await expect(blocked.choose).toBeEnabled();
  await blocked.choose.click();
  await dragTiles(page, [
    { x: 19, y: 19 },
    { x: 19, y: 20 },
  ]);
  await expect(page.locator('#resource-gold-value')).toHaveText(KEEP_TWO_GOLD);
  await expect(page.getByTestId('hint')).toHaveText('No wall placed: that tile is already taken.');
  await expect(page.locator('#placement-banner')).toBeVisible();

  // 3. A stroke that runs into the starter rock stops there: the accepted prefix
  //    is built, the rock and the cells beyond it are untouched.
  await page.keyboard.press('Escape');
  await (await openWallCard(page)).choose.click();
  await dragTiles(page, [
    { x: 8, y: 20 },
    { x: 7, y: 20 },
    { x: 6, y: 20 },
  ]);
  await expect(page.locator('#resource-gold-value')).toHaveText('980 / 1600');
  await expect(page.getByTestId('hint')).toHaveText(
    'Placed 2 wall segments, then stopped: that tile is already taken.',
  );
  await page.clock.runFor(SAVE_DEBOUNCE_MS);
  const revisionAfterRock = await waitForRevisionAfter(page, revisionBefore);

  // Free the builder, then cross the same two tiles repeatedly: one wall each,
  // one charge each.
  await page.clock.runFor(WALL_FINISH_MS);
  await settle(page);
  await expect(page.locator('#builders-count')).toHaveText('2 / 2 available');
  await dragTiles(page, [
    { x: 14, y: 30 },
    { x: 15, y: 30 },
    { x: 14, y: 30 },
    { x: 15, y: 30 },
  ]);
  await expect(page.locator('#resource-gold-value')).toHaveText('960 / 1600');
  await expect(page.getByTestId('hint')).toHaveText('Placed 2 wall segments.');

  // 4. All of it survives a reload: the prefix wall, the two crossed tiles, and
  //    the rock that stopped the stroke.
  await page.clock.runFor(WALL_FINISH_MS);
  await settle(page);
  await page.clock.runFor(SAVE_DEBOUNCE_MS);
  await waitForRevisionAfter(page, revisionAfterRock);

  await page.reload();
  await expect(page.locator('#game canvas')).toBeVisible();
  await expect(page.locator('#resource-gold-value')).toHaveText('960 / 1600');

  for (const tile of [
    { x: 8, y: 20 },
    { x: 7, y: 20 },
    { x: 14, y: 30 },
    { x: 15, y: 30 },
  ]) {
    await tapTile(page, tile);
    await expect(page.locator('#selection-title')).toHaveText('Wall');
  }
  // The rock is still an obstacle, so the refused cell was never built over.
  await tapTile(page, { x: 6, y: 20 });
  await expect(page.locator('#selection-title')).toHaveText('Rock');

  browserErrors.expectNone('the cancel and partial-stroke journey');
});

test('camera pan still works outside wall placement', async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);

  await page.clock.install({ time: START_TIME });
  await page.goto('/');
  await expect(page.locator('#game canvas')).toBeVisible();
  await freezeClock(page);

  const probe = await canvasPoint(page, CAMERA_PROBE);
  await page.mouse.move(probe.x, probe.y);
  await settle(page);
  const before = await page.getByTestId('tile').textContent();

  // A plain one-finger drag with no placement mode open is still a camera pan.
  await page.mouse.down();
  await settle(page);
  await page.mouse.move(probe.x + 96, probe.y, { steps: 6 });
  await settle(page);
  await page.mouse.up();
  await settle(page);

  await page.mouse.move(probe.x, probe.y);
  await settle(page);
  const after = await page.getByTestId('tile').textContent();

  expect(after).not.toBe(before);

  browserErrors.expectNone('the idle camera-pan scenario');
});
