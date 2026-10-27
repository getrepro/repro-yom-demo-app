import './repro.mjs';

// Load transport libraries after instrumentation; Socket.IO caches WebSocket at evaluation.
await new Promise((resolve, reject) => {
  const script = document.createElement('script');
  script.src = '/socket.io/socket.io.js';
  script.onload = resolve; script.onerror = reject;
  document.head.append(script);
});

const params = new URLSearchParams(location.hash.slice(1));
const sessionId = params.get('session'), token = params.get('token'), scenario = params.get('scenario');
const parentOrigin = params.get('parent');
const video = document.querySelector('video');
const status = document.querySelector('#status');
const retry = document.querySelector('#retry');
const isShooter = params.get('game') === 'bananabread';
document.querySelector('#fire').hidden = !isShooter;
lucide.createIcons();
const socket = io({ auth: { sessionId, token, role: 'player' } });
let peer, channel, sequence = 0, candidates = [], presented = 0, lastPresentation = 0, freezeTimer;
let connectionTimer, disposed = false, failed = false, hasFrame = false;
window.playerStats = { presented: 0, decoded: 0, inputAcknowledged: 0 };
function announce(type, data = {}) {
  if (parentOrigin && window.parent !== window) window.parent.postMessage({ type, sessionId, ...data }, parentOrigin);
}
function show(value, state = 'connecting') {
  status.textContent = value;
  Object.assign(window.playerStats, { status: value, state });
  announce('stream-status', { status: value, state });
}
function fail(message) {
  if (disposed || failed) return;
  failed = true;
  clearTimeout(connectionTimer);
  peer?.close();
  retry.hidden = false;
  show(message, 'failed');
}
function awaitConnection() {
  if (disposed) return;
  failed = false; hasFrame = false; retry.hidden = true;
  show('Connecting to game host');
  armFirstFrameDeadline();
}
function armFirstFrameDeadline() {
  clearTimeout(connectionTimer);
  // Browsers may suspend presentation callbacks in hidden tabs even when ICE
  // and decoding work. Start the presentation deadline when the player is visible.
  if (!document.hidden) connectionTimer = setTimeout(() => fail('Connection timed out. Retry the stream.'), 15_000);
}
document.addEventListener('visibilitychange', () => {
  if (!disposed && !failed && !hasFrame) armFirstFrameDeadline();
});
retry.addEventListener('click', () => location.reload());
socket.on('connect', awaitConnection);
socket.on('connect_error', error => fail(error.message));
socket.on('disconnect', () => fail('Signaling disconnected. Retry the stream.'));
socket.on('peer-left', () => fail('Game host disconnected. Retry the stream.'));
awaitConnection();
socket.on('signal', async message => {
  if (disposed || failed) return;
  try {
    if (message.type === 'offer') {
      peer?.close();
      const connection = peer = new RTCPeerConnection({ iceServers: [] });
      connection.onicecandidate = ({ candidate }) => candidate && socket.emit('signal', { type: 'candidate', candidate });
      connection.ontrack = event => {
        if (peer !== connection || failed) return;
        video.srcObject = event.streams[0];
        video.play().catch(() => show('Select the player to resume'));
      };
      connection.ondatachannel = event => {
        channel = event.channel;
        channel.onmessage = ({ data }) => {
          const ack = JSON.parse(data);
          window.playerStats.inputAcknowledged = ack.sequence;
        };
      };
      connection.onconnectionstatechange = () => {
        if (peer !== connection || disposed || failed) return;
        if (connection.connectionState === 'failed') fail('Stream connection failed. Retry the stream.');
        else if (connection.connectionState === 'disconnected') fail('Stream disconnected. Retry the stream.');
        else if (connection.connectionState === 'connected' && !hasFrame) show('Connected. Waiting for video');
      };
      await connection.setRemoteDescription(message.description);
      for (const candidate of candidates.splice(0)) await connection.addIceCandidate(candidate);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      socket.emit('signal', { type: 'answer', description: connection.localDescription });
    } else if (message.type === 'candidate') {
      if (peer?.remoteDescription) await peer.addIceCandidate(message.candidate);
      else candidates.push(message.candidate);
    }
  } catch (error) { fail('Connection interrupted. Retry the stream.'); console.error(error); }
});
function sendInput(action, code, extra = {}) {
  if (channel?.readyState !== 'open') return;
  channel.send(JSON.stringify({ action, code, ...extra, sequence: ++sequence }));
}
const allowed = new Set(['ArrowLeft','ArrowUp','ArrowRight','ArrowDown','KeyW','KeyA','KeyS','KeyD','Space','Digit1','Digit2','Digit3','Digit4']);
document.addEventListener('keydown', event => {
  if (!allowed.has(event.code) || event.repeat) return;
  event.preventDefault(); sendInput('down', event.code);
});
document.addEventListener('keyup', event => {
  if (!allowed.has(event.code)) return;
  event.preventDefault(); sendInput('up', event.code);
});
window.addEventListener('blur', () => sendInput('reset'));
for (const button of document.querySelectorAll('button[data-code]')) {
  button.addEventListener('pointerdown', event => { button.setPointerCapture(event.pointerId); sendInput('down', button.dataset.code); });
  button.addEventListener('pointerup', () => sendInput('up', button.dataset.code));
  button.addEventListener('pointercancel', () => sendInput('up', button.dataset.code));
}
const fire = document.querySelector('#fire');
fire.addEventListener('pointerdown', event => { fire.setPointerCapture(event.pointerId); sendInput('fire', undefined, { down: true }); });
for (const name of ['pointerup', 'pointercancel']) fire.addEventListener(name, () => sendInput('fire', undefined, { down: false }));
video.addEventListener('click', () => {
  video.play();
  if (isShooter) video.requestPointerLock()?.catch(error => {
    window.playerStats.pointerLockError = error.message;
  });
});
let dragging;
video.addEventListener('pointerdown', event => {
  if (!isShooter || document.pointerLockElement === video || event.button !== 0) return;
  dragging = { id: event.pointerId, x: event.clientX, y: event.clientY };
  video.setPointerCapture(event.pointerId);
});
video.addEventListener('pointermove', event => {
  if (!dragging || dragging.id !== event.pointerId || document.pointerLockElement === video) return;
  sendInput('look', undefined, { dx: event.clientX - dragging.x, dy: event.clientY - dragging.y });
  dragging.x = event.clientX; dragging.y = event.clientY;
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  video.addEventListener(name, () => { dragging = undefined; });
}
document.addEventListener('mousemove', event => {
  if (document.pointerLockElement === video) sendInput('look', undefined, { dx: event.movementX, dy: event.movementY });
});
video.addEventListener('mousedown', event => {
  if (event.button === 0 && document.pointerLockElement === video) sendInput('fire', undefined, { down: true });
});
document.addEventListener('mouseup', event => { if (event.button === 0) sendInput('fire', undefined, { down: false }); });
document.addEventListener('pointerlockchange', () => { dragging = undefined; if (!document.pointerLockElement) sendInput('reset'); });
function onFrame(now, metadata) {
  if (disposed) return;
  if (!failed && !hasFrame) {
    hasFrame = true;
    clearTimeout(connectionTimer);
    show('Live', 'live');
    announce('stream-connected');
  }
  presented++;
  lastPresentation = now;
  Object.assign(window.playerStats, { presented, mediaTime: metadata.mediaTime, width: metadata.width, height: metadata.height });
  video.requestVideoFrameCallback(onFrame);
}
video.requestVideoFrameCallback(onFrame);
video.addEventListener('playing', () => {
  if (scenario === 'presentation-stall' && !freezeTimer) freezeTimer = setTimeout(() => video.pause(), 7000);
});
const monitor = setInterval(async () => {
  if (disposed || failed || !hasFrame || !peer || peer.connectionState !== 'connected') return;
  const connection = peer;
  let stats;
  try { stats = await connection.getStats(); } catch { return; }
  if (disposed || failed || peer !== connection) return;
  stats.forEach(report => {
    if (report.type === 'inbound-rtp' && report.kind === 'video') {
      Object.assign(window.playerStats, { decoded: report.framesDecoded ?? 0, bytes: report.bytesReceived });
    }
  });
  const stalled = lastPresentation > 0 && performance.now() - lastPresentation > 2000;
  show(stalled ? 'Stream interrupted' : `Connected / ${video.videoWidth} x ${video.videoHeight}`, stalled ? 'stalled' : 'live');
  announce('stream-stats', { stats: { ...window.playerStats, stalled } });
}, 1000);
let cleanupPromise;
function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  disposed = true;
  clearInterval(monitor); clearTimeout(freezeTimer); clearTimeout(connectionTimer);
  peer?.close();
  video.srcObject?.getTracks().forEach(track => track.stop());
  socket.disconnect();
  cleanupPromise = (async () => {
    try { await window.reproFrame?.destroy(); }
    catch { console.warn('[Repro] Final capture acknowledgement unavailable.'); }
    finally { announce('stream-ended'); }
  })();
  return cleanupPromise;
}
socket.on('session-ended', cleanup);
window.addEventListener('message', event => {
  if (event.source === window.parent && event.origin === parentOrigin
    && event.data?.type === 'end-stream' && event.data.sessionId === sessionId) {
    // The server may have finished cleanup before the parent received settlement.
    void cleanup().then(() => announce('stream-ended'));
  }
});
window.addEventListener('pagehide', cleanup, { once: true });
