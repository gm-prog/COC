/**
 * Isometric projection helpers.
 *
 * The game logic lives on a square tile grid; only this module knows that the
 * camera draws it isometrically at a 2:1 ratio. Nothing here may contain game
 * rules — it is pure geometry so it can be unit tested without a canvas.
 */

/** Screen width of one tile diamond. */
export const TILE_WIDTH = 64;
/** Screen height of one tile diamond (2:1 isometric ratio). */
export const TILE_HEIGHT = 32;

export interface Point {
  x: number;
  y: number;
}

/** Project a tile coordinate to the screen position of its top corner. */
export function tileToScreen(tileX: number, tileY: number): Point {
  return {
    x: (tileX - tileY) * (TILE_WIDTH / 2),
    y: (tileX + tileY) * (TILE_HEIGHT / 2),
  };
}

/** Project a tile coordinate to the screen position of the tile's centre. */
export function tileCenterToScreen(tileX: number, tileY: number): Point {
  return tileToScreen(tileX + 0.5, tileY + 0.5);
}

/** Inverse projection: screen position -> fractional tile coordinate. */
export function screenToTile(screenX: number, screenY: number): Point {
  const a = screenX / (TILE_WIDTH / 2);
  const b = screenY / (TILE_HEIGHT / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** Inverse projection, floored to the tile the point falls inside. */
export function screenToTileFloor(screenX: number, screenY: number): Point {
  const tile = screenToTile(screenX, screenY);
  return { x: Math.floor(tile.x), y: Math.floor(tile.y) };
}

/** The four screen-space corners of an axis-aligned tile rectangle. */
export function tileRectToScreenQuad(
  tileX: number,
  tileY: number,
  width: number,
  height: number,
): Point[] {
  return [
    tileToScreen(tileX, tileY),
    tileToScreen(tileX + width, tileY),
    tileToScreen(tileX + width, tileY + height),
    tileToScreen(tileX, tileY + height),
  ];
}
