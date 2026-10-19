/**
 * Pure camera transform maths for the isometric village view.
 *
 * Deliberately free of Phaser so it can be unit tested without a canvas, and so
 * the exact same maths can be reused by a future minimap or replay camera.
 *
 * Model: the grid is drawn inside a container scaled by `zoom` and positioned at
 * (`panX`, `panY`), which is the screen position of world point (0, 0):
 *
 *     screen = world * zoom + pan        ⇔        world = (screen - pan) / zoom
 *
 * Because the projection is linear, "keep this world point under the cursor" is
 * exact rather than approximate.
 */

export interface CameraTransform {
  zoom: number;
  panX: number;
  panY: number;
}

export interface ViewBounds {
  viewWidth: number;
  viewHeight: number;
  worldWidth: number;
  worldHeight: number;
}

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2.5;

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return MIN_ZOOM;
  return clamp(zoom, MIN_ZOOM, MAX_ZOOM);
}

export function screenToWorld(
  transform: CameraTransform,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  return {
    x: (screenX - transform.panX) / transform.zoom,
    y: (screenY - transform.panY) / transform.zoom,
  };
}

export function worldToScreen(
  transform: CameraTransform,
  worldX: number,
  worldY: number,
): { x: number; y: number } {
  return {
    x: worldX * transform.zoom + transform.panX,
    y: worldY * transform.zoom + transform.panY,
  };
}

/**
 * Keeps the map inside the viewport. When the whole map fits on an axis it is
 * centred on that axis; otherwise panning is clamped so the map never slides
 * away entirely.
 *
 * Derivation (screen = world * zoom + pan, world spans x∈[-W/2, W/2], y∈[0, H]):
 *   panX ∈ [viewWidth - W·zoom/2, W·zoom/2]
 *   panY ∈ [viewHeight - H·zoom, 0]
 * Both intervals are empty when the world is smaller than the viewport on that
 * axis, in which case the world is simply centred.
 */
export function clampPan(transform: CameraTransform, bounds: ViewBounds): CameraTransform {
  const { zoom } = transform;
  const { viewWidth, viewHeight, worldWidth, worldHeight } = bounds;

  const minX = viewWidth - (worldWidth * zoom) / 2;
  const maxX = (worldWidth * zoom) / 2;
  const minY = viewHeight - worldHeight * zoom;
  const maxY = 0;

  return {
    zoom,
    panX: worldWidth * zoom <= viewWidth ? (minX + maxX) / 2 : clamp(transform.panX, minX, maxX),
    panY: worldHeight * zoom <= viewHeight ? (minY + maxY) / 2 : clamp(transform.panY, minY, maxY),
  };
}

export function panBy(
  transform: CameraTransform,
  dx: number,
  dy: number,
  bounds: ViewBounds,
): CameraTransform {
  return clampPan({ ...transform, panX: transform.panX + dx, panY: transform.panY + dy }, bounds);
}

/** Zooms by `factor` while keeping the world point under (screenX, screenY) still. */
export function zoomAt(
  transform: CameraTransform,
  screenX: number,
  screenY: number,
  factor: number,
  bounds: ViewBounds,
): CameraTransform {
  const world = screenToWorld(transform, screenX, screenY);
  const zoom = clampZoom(transform.zoom * factor);
  return clampPan({ zoom, panX: screenX - world.x * zoom, panY: screenY - world.y * zoom }, bounds);
}

/** Fits the world in the middle of the viewport at 1:1 zoom. */
export function centerOnWorld(bounds: ViewBounds): CameraTransform {
  return clampPan(
    {
      zoom: 1,
      panX: bounds.viewWidth / 2,
      panY: bounds.viewHeight / 2 - bounds.worldHeight / 2,
    },
    bounds,
  );
}

/** Screen-space size of the projected tile grid (see `iso.ts`). */
export function worldSizeForGrid(
  gridTotal: number,
  tileWidth: number,
  tileHeight: number,
): { worldWidth: number; worldHeight: number } {
  return {
    worldWidth: gridTotal * tileWidth,
    worldHeight: gridTotal * tileHeight,
  };
}
