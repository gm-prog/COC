import Phaser from 'phaser';
import type { VillageBootstrap } from '../persistence/bootstrap';
import { BootScene } from '../scenes/BootScene';

/**
 * Builds the Phaser game instance.
 *
 * Scale.RESIZE keeps the canvas filling its parent, which is what the browser
 * preview and the mobile web view need; Capacitor gets the same behaviour.
 *
 * `village` is the already-resolved starting state. The scene is handed the
 * finished object, so nothing in the game can observe a placeholder village.
 */
export function createGame(parent: HTMLElement, village: VillageBootstrap): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: '#0d1117',
    transparent: false,
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.NO_CENTER,
      width: parent.clientWidth || 960,
      height: parent.clientHeight || 540,
    },
    render: {
      antialias: true,
      powerPreference: 'high-performance',
      roundPixels: false,
    },
    scene: [new BootScene(village)],
    // Phaser's banner is noise in the console during CI/dev.
    banner: false,
    audio: { noAudio: true },
  });
}
