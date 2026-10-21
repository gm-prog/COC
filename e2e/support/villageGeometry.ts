/**
 * Screen geometry for the browser smoke test.
 *
 * The test has to click *tiles*, but the canvas only exposes pixels. Rather than
 * hard-coding coordinates, this module reuses the same pure helpers the client
 * uses to draw and hit-test the village:
 *
 * - `apps/client/src/iso.ts`            — tile ⇄ screen projection (2:1 iso)
 * - `apps/client/src/cameraTransform.ts` — zoom/pan maths
 * - `packages/sim-core/.../geometry.ts`  — the 48-tile grid
 *
 * `BootScene.recenter()` sets the camera to `centerOnWorld(bounds)` at zoom 1 on
 * boot, and nothing pans or zooms it before the test clicks, so replaying that
 * one call reproduces the live transform exactly. The test still proves the
 * result against the running app: it hovers the computed point and asserts the
 * HUD's own "Tile" readout before committing the click.
 */

import type { Page } from '@playwright/test';
import { GRID } from '../../packages/sim-core/src/config/geometry';
import { tileCenterToScreen, TILE_HEIGHT, TILE_WIDTH } from '../../apps/client/src/iso';
import {
  centerOnWorld,
  worldSizeForGrid,
  worldToScreen,
} from '../../apps/client/src/cameraTransform';

/** Screen-space size of the whole map at zoom 1, exactly as `BootScene` computes it. */
export const WORLD_SIZE = worldSizeForGrid(GRID.total, TILE_WIDTH, TILE_HEIGHT);

export interface CanvasBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Tile {
  x: number;
  y: number;
}

/**
 * Page-space point at the centre of `tile`.
 *
 * `canvas` is the canvas's bounding box in page coordinates (`x`/`y` are the
 * canvas origin inside the viewport), which is where Phaser's pointer
 * coordinates start counting from.
 */
export function tileCenterToPage(canvas: CanvasBox, tile: Tile): { x: number; y: number } {
  const camera = centerOnWorld({
    viewWidth: canvas.width,
    viewHeight: canvas.height,
    worldWidth: WORLD_SIZE.worldWidth,
    worldHeight: WORLD_SIZE.worldHeight,
  });
  const world = tileCenterToScreen(tile.x, tile.y);
  const screen = worldToScreen(camera, world.x, world.y);
  return { x: canvas.x + screen.x, y: canvas.y + screen.y };
}

/**
 * The Phaser canvas's position and CSS size.
 *
 * Read from the live element rather than assumed from the viewport: Phaser's
 * `Scale.RESIZE` makes the canvas follow its parent, and Phaser's pointer
 * coordinates are CSS pixels relative to that canvas.
 */
export async function canvasBox(page: Page): Promise<CanvasBox> {
  const box = await page.locator('#game canvas').boundingBox();
  if (box === null) throw new Error('The Phaser canvas is not attached or has no layout box');
  return box;
}
