import './styles.css';
import { GAME_CONFIG } from '@coc/game-data';
import { createGame } from './game/createGame';
import { bootstrapVillage, unsavedVillage } from './persistence/bootstrap';

const container = document.getElementById('game');

if (!container) {
  throw new Error('Emberhold: #game container is missing from index.html');
}

/**
 * Resolves the village before the game exists.
 *
 * The scene never starts on a placeholder: `bootstrapVillage` either restores
 * and reconciles a save or builds the configured starter, and only then is the
 * Phaser game handed the result. Input therefore cannot race with a restore.
 */
const start = async (): Promise<void> => {
  const village = await bootstrapVillage({
    config: GAME_CONFIG,
    now: () => Date.now(),
  });
  createGame(container, village);
};

void start().catch((error: unknown) => {
  // `bootstrapVillage` is written not to throw; this is the last line of
  // defence, so an unexpected storage failure still leaves a playable village.
  console.error('Emberhold: village bootstrap failed', error);
  createGame(
    container,
    unsavedVillage(GAME_CONFIG, Date.now(), {
      code: 'storage_unavailable',
      message: error instanceof Error ? error.message : String(error),
    }),
  );
});
