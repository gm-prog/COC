import {
  applyCommand,
  type CommandErrorCode,
  type GameConfig,
  type PlayerState,
} from '@coc/sim-core';

export type BuildingPlacementPreview =
  | { valid: true }
  | { valid: false; errorCode: CommandErrorCode };

/**
 * Runs the real placement command against a snapshot without mutating it.
 * This keeps preview validity aligned with the command's bounds, occupancy,
 * Keep gating, quantity, builder, and resource rules.
 */
export function previewBuildingPlacement(
  state: PlayerState,
  config: GameConfig,
  buildingType: string,
  x: number,
  y: number,
  now: number,
): BuildingPlacementPreview {
  const result = applyCommand(
    state,
    {
      id: 'placement-preview',
      type: 'PlaceBuilding',
      payload: { buildingType, x, y },
    },
    { config, now },
  );

  return result.ok ? { valid: true } : { valid: false, errorCode: result.error.code };
}
