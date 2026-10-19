import './styles.css';
import { createGame } from './game/createGame';

const container = document.getElementById('game');

if (!container) {
  throw new Error('Emberhold: #game container is missing from index.html');
}

createGame(container);
