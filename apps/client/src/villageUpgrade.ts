import {
  checkUpgrade,
  upgradeDurationMs,
  type BuildingLevel,
  type GameConfig,
  type PlayerState,
  type UpgradeRejection,
} from '@coc/sim-core';

export type BuildingUpgradeSnapshot =
  | {
      kind: 'available';
      currentLevel: number;
      target: BuildingLevel;
      durationMs: number;
    }
  | {
      kind: 'blocked';
      currentLevel: number;
      target: BuildingLevel;
      durationMs: number;
      requiredKeep: number;
      reason: UpgradeRejection;
    }
  | {
      kind: 'in_progress';
      currentLevel: number;
      targetLevel: number;
      remainingMs: number;
      target?: BuildingLevel;
    }
  | { kind: 'max_level'; currentLevel: number }
  | { kind: 'missing' };

/**
 * Read-only view of the next upgrade. Sim-core remains the authority for
 * affordability, Keep gates, and builder availability when the user confirms.
 */
export function getBuildingUpgradeSnapshot(
  state: PlayerState,
  config: GameConfig,
  buildingId: number,
  now: number,
): BuildingUpgradeSnapshot {
  const building = state.buildings.find((candidate) => candidate.id === buildingId);
  if (!building) return { kind: 'missing' };

  const definition = config.buildings.find((candidate) => candidate.id === building.type);
  if (!definition) return { kind: 'missing' };

  if (building.upgrade !== undefined) {
    return {
      kind: 'in_progress',
      currentLevel: building.level,
      targetLevel: building.upgrade.toLevel,
      remainingMs: Math.max(0, building.upgrade.finishAt - now),
      target: definition.levels.find((entry) => entry.level === building.upgrade?.toLevel),
    };
  }

  const target = definition.levels.find((entry) => entry.level === building.level + 1);
  if (!target) return { kind: 'max_level', currentLevel: building.level };

  const durationMs = upgradeDurationMs(config, building.type, target.level);
  const check = checkUpgrade(state, buildingId, config);
  if (check.ok) {
    return {
      kind: 'available',
      currentLevel: building.level,
      target: check.target,
      durationMs,
    };
  }

  return {
    kind: 'blocked',
    currentLevel: building.level,
    target,
    durationMs,
    requiredKeep: target.requiresKeep ?? 1,
    reason: check.rejection,
  };
}
