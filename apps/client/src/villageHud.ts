import {
  storageCapacity,
  type GameConfig,
  type PlayerState,
  type ResourceId,
} from '@coc/sim-core';

const RESOURCE_ORDER: readonly ResourceId[] = ['gold', 'essence', 'shards', 'gems'];

export interface VillageResourceSnapshot {
  id: ResourceId;
  amount: number;
  /** Missing when the game config gives this resource no storage cap. */
  capacity?: number;
}

export interface BusyBuilderSnapshot {
  buildingId: number;
  buildingType: string;
  remainingMs: number;
}

export interface VillageHudSnapshot {
  resources: VillageResourceSnapshot[];
  builders: {
    total: number;
    available: number;
    busy: BusyBuilderSnapshot[];
  };
}

/**
 * Derives presentation-only resource and builder values from the authoritative
 * player state and validated config. The caller supplies now so the helper
 * stays deterministic and unit-testable.
 */
export function buildVillageHudSnapshot(
  state: PlayerState,
  config: GameConfig,
  now: number,
): VillageHudSnapshot {
  const capacities = storageCapacity(state, config);
  const resources = RESOURCE_ORDER.map((id): VillageResourceSnapshot => {
    const capacity = capacities[id];
    return {
      id,
      amount: state.resources[id] ?? 0,
      ...(capacity !== undefined && capacity > 0 ? { capacity } : {}),
    };
  });

  const busy = [...state.builders.busy]
    .sort((a, b) => a.finishAt - b.finishAt || a.buildingId - b.buildingId)
    .map((assignment): BusyBuilderSnapshot => ({
      buildingId: assignment.buildingId,
      buildingType:
        state.buildings.find((building) => building.id === assignment.buildingId)?.type ??
        'unknown_building',
      remainingMs: Math.max(0, assignment.finishAt - now),
    }));

  return {
    resources,
    builders: {
      total: state.builders.count,
      available: Math.max(0, state.builders.count - busy.length),
      busy,
    },
  };
}

/** A compact countdown suitable for the builder HUD. */
export function formatRemainingDuration(remainingMs: number): string {
  const totalSeconds = Math.ceil(Math.max(0, remainingMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return minutes > 0 ? hours + 'h ' + minutes + 'm' : hours + 'h';
  if (totalSeconds >= 60) return minutes + 'm ' + String(seconds).padStart(2, '0') + 's';
  return totalSeconds + 's';
}
