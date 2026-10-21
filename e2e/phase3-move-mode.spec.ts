import { expect, test, type Page } from '@playwright/test';
import { collectBrowserErrors } from './support/browserErrors';
import { canvasBox, tileCenterToPage, type Tile } from './support/villageGeometry';

/**
 * Phase 3 browser test: Move Mode (Gate C item 6).
 *
 * The player journey is driven exactly as a person drives it — select the
 * starter Essence Well, press the visible **Move** button, choose a tile, watch the
 * selection panel update, wait for the save indicator, reload, and find the
 * building where it was left. Nothing reaches into the scene's state; the only
 * non-UI read is the stored `revision`, used once to prove that a cancelled or
 * rejected move wrote nothing at all.
 *
 * ## Why the starter Essence Well
 *
 * It exists in every fresh village at (23, 17) with a known 3×3 footprint, so
 * no shop step, construction wait or resource arithmetic is needed. Its centre
 * lands at (832, 288) on a 1280×800 canvas — clear of the status row, the
 * village panel, the selection panel and the move banner. That matters because
 * the HUD is a DOM layer over the canvas, and a tap meant for a building has to
 * reach the game rather than a panel.
 */

/** Fixed wall clock for both scenarios. */
const START_TIME = new Date('2026-01-01T00:00:00.000Z');

/** `starter.json`: Essence Well 3, level 1, anchored at (23, 17). */
const WELL_TILE: Tile = { x: 23, y: 17 };

/**
 * A free 3×3 destination in the buildable core. Clear of the Keep (18–21), the
 * Gold Mine (14–16 × 17–19), the well's own old tiles and every starter
 * obstacle; its centre (640, 416) is the tile the existing smoke test already
 * proves is on screen and clear of every HUD panel.
 */
const DESTINATION: Tile = { x: 24, y: 24 };

/** The Keep occupies 18–21 on both axes, so this destination always overlaps it. */
const BLOCKED_TILE: Tile = { x: 18, y: 18 };

/** Simulated time that covers the autosave debounce (400 ms) with margin. */
const SAVE_DEBOUNCE_MS = 1_000;
/** One frame's worth of simulated time, enough for Phaser to process input. */
const FRAME_MS = 120;

/** Pins the clock a little ahead of now, absorbing round-trip latency. */
async function freezeClock(page: Page): Promise<void> {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(now + 2_000));
}

/** One burst of frames so Phaser dispatches queued pointer events. */
async function settle(page: Page): Promise<void> {
  await page.clock.runFor(FRAME_MS);
}

/** Hover, press and release across separate frames, as a slow tap would. */
async function tapCanvas(page: Page, point: { x: number; y: number }): Promise<void> {
  await page.mouse.move(point.x, point.y);
  await settle(page);
  await page.mouse.down();
  await settle(page);
  await page.mouse.up();
  await settle(page);
}

/**
 * The committed record's `revision`, read straight from IndexedDB.
 *
 * A save only exists because a transaction committed, so this is the honest way
 * to show that an interaction wrote nothing: rejected and cancelled moves must
 * leave the number untouched.
 */
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

/** Selects the starter Essence Well and opens the selection panel. */
async function selectStarterWell(page: Page): Promise<void> {
  await tapCanvas(page, tileCenterToPage(await canvasBox(page), WELL_TILE));
  await expect(page.getByTestId('selection-panel')).toBeVisible();
  await expect(page.locator('#selection-title')).toHaveText('Essence Well');
  await expect(page.locator('#selection-meta')).toHaveText('Level 1 · Tile 23, 17');
}

test('a building can be moved and is still moved after a reload', async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);

  await page.clock.install({ time: START_TIME });
  await page.goto('/');

  await expect(page.locator('#game canvas')).toBeVisible();
  await expect(page.locator('#resource-gold-value')).toHaveText('1000 / 1000');
  await expect(page.locator('#builders-count')).toHaveText('2 / 2 available');
  await freezeClock(page);

  // 0. Let the starter village commit, so the revision below is a clean
  //    baseline for the move's own write.
  await page.clock.runFor(SAVE_DEBOUNCE_MS);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-save-state', 'saved');
  const revisionBefore = await storedRevision(page);
  expect(revisionBefore).toBeGreaterThan(0);

  // 1. Select a starter building, not a newly placed one.
  await selectStarterWell(page);

  // 2. The selection panel offers the Move action, named for the building.
  const moveButton = page.getByTestId('selection-move');
  await expect(moveButton).toBeVisible();
  await expect(moveButton).toBeEnabled();
  await expect(moveButton).toHaveText('Move');
  await expect(moveButton).toHaveAccessibleName('Move Essence Well');

  // 3. Enter Move Mode. Entering it changes nothing: the village, its
  //    resources and its builders are exactly as they were.
  await moveButton.click();
  const banner = page.locator('#placement-banner');
  await expect(banner).toBeVisible();
  await expect(page.locator('#placement-title')).toHaveText('Move Essence Well');
  await expect(page.locator('#placement-feedback')).toHaveText(
    'Tap a buildable tile to place this building there.',
  );
  // The details and the original coordinates stay on screen while choosing.
  await expect(page.getByTestId('selection-panel')).toBeVisible();
  await expect(page.locator('#selection-meta')).toHaveText('Level 1 · Tile 23, 17');
  await expect(page.locator('#resource-gold-value')).toHaveText('1000 / 1000');
  await expect(page.locator('#builders-count')).toHaveText('2 / 2 available');

  // 4. Point at a valid destination: the preview turns positive and the HUD
  //    reports the hovered tile, proving the projection against the live game.
  const destination = tileCenterToPage(await canvasBox(page), DESTINATION);
  await page.mouse.move(destination.x, destination.y);
  await settle(page);
  await expect(page.getByTestId('tile')).toHaveText('24, 24');
  await expect(page.locator('#placement-feedback')).toHaveText('Valid destination — tap to move');

  // 5. Commit. The building is adopted from the command's own state.
  await page.mouse.down();
  await settle(page);
  await page.mouse.up();
  await settle(page);

  await expect(banner).toBeHidden();
  await expect(page.locator('#selection-meta')).toHaveText('Level 1 · Tile 24, 24');
  await expect(page.getByTestId('hint')).toHaveText('Moved Essence Well to 24, 24.');
  // A move is free and instant under the current contract (D27): no resources,
  // no builder, no construction.
  await expect(page.locator('#resource-gold-value')).toHaveText('1000 / 1000');
  await expect(page.locator('#resource-essence-value')).toHaveText('1000 / 1000');
  await expect(page.locator('#builders-count')).toHaveText('2 / 2 available');
  await expect(page.locator('#builder-countdowns')).toBeHidden();

  // 6. Wait for the transaction to commit. `saved` is only set from `oncomplete`,
  //    so this is confirmation rather than a hopeful pause.
  await page.clock.runFor(SAVE_DEBOUNCE_MS);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-save-state', 'saved');
  // The indicator is not the only evidence: the record itself advanced, which
  // only a committed transaction can do.
  expect(await storedRevision(page)).toBeGreaterThan(revisionBefore);

  // 7. Reload — same browser context, so the same IndexedDB.
  await page.reload();
  await expect(page.locator('#game canvas')).toBeVisible();

  // 8. The building is at its new location and no longer at the old one.
  const restored = tileCenterToPage(await canvasBox(page), DESTINATION);
  await tapCanvas(page, restored);
  await expect(page.getByTestId('selection-panel')).toBeVisible();
  await expect(page.locator('#selection-title')).toHaveText('Essence Well');
  await expect(page.locator('#selection-meta')).toHaveText('Level 1 · Tile 24, 24');

  const oldSpot = tileCenterToPage(await canvasBox(page), WELL_TILE);
  await tapCanvas(page, oldSpot);
  await expect(page.getByTestId('selection-panel')).toBeHidden();

  browserErrors.expectNone('the move and reload journey');
});

test('a rejected destination and a cancelled move leave the building in place', async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);

  await page.clock.install({ time: START_TIME });
  await page.goto('/');

  await expect(page.locator('#game canvas')).toBeVisible();
  await freezeClock(page);
  await selectStarterWell(page);

  // The starter save has committed by now; remember its revision so the end of
  // the test can prove that none of the interactions below wrote anything.
  await page.clock.runFor(SAVE_DEBOUNCE_MS);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-save-state', 'saved');
  const revisionBefore = await storedRevision(page);
  expect(revisionBefore).toBeGreaterThan(0);

  // 1. An occupied destination is refused, and Move Mode stays open so the
  //    player can simply pick another tile.
  const moveButton = page.getByTestId('selection-move');
  await moveButton.click();
  const banner = page.locator('#placement-banner');
  await expect(banner).toBeVisible();

  const blocked = tileCenterToPage(await canvasBox(page), BLOCKED_TILE);
  await page.mouse.move(blocked.x, blocked.y);
  await settle(page);
  await expect(page.getByTestId('tile')).toHaveText('18, 18');
  await expect(page.locator('#placement-feedback')).toHaveText(
    'Blocked — choose an empty buildable tile',
  );

  await page.mouse.down();
  await settle(page);
  await page.mouse.up();
  await settle(page);

  await expect(banner).toBeVisible();
  await expect(page.locator('#placement-feedback')).toHaveText(
    'Blocked — choose an empty buildable tile',
  );
  await expect(page.locator('#selection-meta')).toHaveText('Level 1 · Tile 23, 17');

  // 2. Escape cancels the mode and the building is untouched.
  await page.keyboard.press('Escape');
  await expect(banner).toBeHidden();
  await expect(page.locator('#selection-meta')).toHaveText('Level 1 · Tile 23, 17');
  await expect(page.getByTestId('selection-panel')).toBeVisible();

  // 3. The banner's Cancel button does the same.
  await moveButton.click();
  await expect(banner).toBeVisible();
  await page.locator('#placement-cancel').click();
  await expect(banner).toBeHidden();
  await expect(page.locator('#selection-meta')).toHaveText('Level 1 · Tile 23, 17');

  // 4. Tapping the building's own tile is a deliberate no-op: the mode ends and
  //    no command is sent.
  await moveButton.click();
  await expect(banner).toBeVisible();
  const ownSpot = tileCenterToPage(await canvasBox(page), WELL_TILE);
  await tapCanvas(page, ownSpot);
  await expect(banner).toBeHidden();
  await expect(page.getByTestId('hint')).toHaveText(
    'That building is already there. Pick a different tile or cancel.',
  );
  await expect(page.locator('#selection-meta')).toHaveText('Level 1 · Tile 23, 17');

  // 5. None of the four interactions enqueued a write: the committed revision
  //    is unchanged after the debounce window would have elapsed.
  await page.clock.runFor(SAVE_DEBOUNCE_MS);
  expect(await storedRevision(page)).toBe(revisionBefore);

  // 6. And the village still restores to the original position.
  await page.reload();
  await expect(page.locator('#game canvas')).toBeVisible();
  await selectStarterWell(page);

  browserErrors.expectNone('the rejected and cancelled move journey');
});
