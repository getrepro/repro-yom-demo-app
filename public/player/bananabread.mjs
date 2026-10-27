import { streamGame } from './stream-host.mjs';

const { allocation } = window.hostConfig;
const canvas = document.querySelector('canvas');
canvas.width = allocation.width; canvas.height = allocation.height;
const keyCodes = { KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, ArrowUp: 38,
  ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32, Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52 };
const held = new Set();
function key(code, down) {
  const keyCode = keyCodes[code];
  if (!keyCode) return false;
  document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, keyCode, which: keyCode, bubbles: true }));
  if (down) held.add(code); else held.delete(code);
  return true;
}
function applyInput(input) {
  if (input.action === 'reset') {
    for (const code of held) key(code, false);
    canvas.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    return true;
  }
  if (input.action === 'down' || input.action === 'up') return key(input.code, input.action === 'down');
  if (input.action === 'look' && Number.isFinite(input.dx) && Number.isFinite(input.dy)) {
    // SDL's relative input accepts pointer-lock deltas without locking the hidden host.
    const dx = Math.max(-200, Math.min(200, input.dx)), dy = Math.max(-200, Math.min(200, input.dy));
    const event = new MouseEvent('mousemove', { bubbles: true, movementX: dx, movementY: dy,
      clientX: canvas.width / 2 + dx, clientY: canvas.height / 2 + dy });
    canvas.dispatchEvent(event);
    return true;
  }
  if (input.action === 'fire' && typeof input.down === 'boolean') {
    canvas.dispatchEvent(new MouseEvent(input.down ? 'mousedown' : 'mouseup', { button: 0, bubbles: true }));
    return true;
  }
  return false;
}
let loaded = false;
window.Module = {
  preRun: [], postRun: [], canvas, desiredWidth: allocation.width, desiredHeight: allocation.height,
  print: () => {}, printErr: text => console.error('[BananaBread]', text),
  setStatus: text => { window.gameLoadStatus = text; },
  autoexec: () => {},
  postLoadWorld: () => {
    if (loaded) return;
    loaded = true;
    window.BananaBread.execute('clearconsole; sensitivity 3; showfps 0; soundvol 0; sleep 12000 [addbot 50; addbot 60]');
    // The player's pointer is locked in another document; tell SDL to consume
    // the forwarded relative deltas instead of deriving absolute host coordinates.
    window.Browser.pointerLock = true;
    canvas.focus();
    requestAnimationFrame(() => requestAnimationFrame(() => streamGame({ canvas, applyInput,
      pause: () => Module.pauseMainLoop(), destroy: () => Module.pauseMainLoop() })));
  },
};
async function script(src) {
  await new Promise((resolve, reject) => {
    const element = document.createElement('script'); element.src = src;
    element.onload = resolve; element.onerror = () => reject(new Error(`Game asset failed: ${src}`));
    document.body.append(element);
  });
}
try {
  for (const file of ['js/api.js', 'js/zee.js', 'game/gl-matrix.js', 'game/setup_low.js',
    'game/preload_base.js', 'game/preload_character.js', 'game/preload_low.js']) await script(file);
  const response = await fetch('bb.wasm');
  if (!response.ok) throw new Error('Game is not installed. Run npm run game:install.');
  Module.wasmBinary = await response.arrayBuffer();
  await script('bb.js');
} catch (error) { window.gameLoadError = error.message; throw error; }
