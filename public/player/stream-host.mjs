// Game adapters provide a canvas and input handler; transport never inspects game state.
export function streamGame({ canvas, applyInput, pause, destroy }) {
  const { sessionId, token, key, scenario, allocation } = window.hostConfig;
  const socket = io({ auth: { sessionId, token, key, role: 'host' } });
  const stream = canvas.captureStream(allocation.fps);
  let peer, remoteCandidates = [], ended = false;
  const timers = new Set();
  const later = (fn, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); if (!ended) fn(); }, ms);
    timers.add(timer);
  };
  if (scenario === 'source-freeze' || scenario === 'late-freeze') {
    later(pause, scenario === 'late-freeze' ? 185_000 : 7000);
  }
  socket.on('peer-ready', async () => {
    try {
      peer?.close(); applyInput({ action: 'reset' }); remoteCandidates = [];
      const connection = peer = new RTCPeerConnection({ iceServers: [] });
      for (const track of stream.getTracks()) {
        track.contentHint = 'detail';
        const sender = connection.addTrack(track, stream);
        const parameters = sender.getParameters();
        parameters.degradationPreference = 'maintain-resolution';
        if (parameters.encodings?.length) parameters.encodings[0].maxBitrate = 8_000_000;
        await sender.setParameters(parameters);
      }
      connection.onicecandidate = ({ candidate }) => candidate && socket.emit('signal', { type: 'candidate', candidate });
      const channel = connection.createDataChannel('controls', { ordered: true });
      channel.onmessage = event => {
        if (typeof event.data !== 'string' || event.data.length > 512) return;
        let input;
        try { input = JSON.parse(event.data); } catch { return; }
        if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) return;
        const apply = () => {
          if (peer !== connection || !applyInput(input)) return;
          socket.emit('input-applied', { sequence: input.sequence, action: input.action });
          if (channel.readyState === 'open') channel.send(JSON.stringify({ sequence: input.sequence, appliedAt: Date.now() }));
        };
        if (scenario === 'delayed-controls') later(apply, 750); else apply();
      };
      await connection.setLocalDescription(await connection.createOffer());
      if (peer === connection) socket.emit('signal', { type: 'offer', description: connection.localDescription });
    } catch (error) { console.error('Host offer:', error.message); }
  });
  socket.on('signal', async message => {
    try {
      const connection = peer;
      if (!connection) return;
      if (message.type === 'answer') {
        await connection.setRemoteDescription(message.description);
        for (const candidate of remoteCandidates.splice(0)) await connection.addIceCandidate(candidate);
      } else if (message.type === 'candidate') {
        if (connection.remoteDescription) await connection.addIceCandidate(message.candidate);
        else if (remoteCandidates.length < 64) remoteCandidates.push(message.candidate);
      }
    } catch (error) { console.error('Host signaling:', error.message); }
  });
  socket.on('peer-left', () => { peer?.close(); applyInput({ action: 'reset' }); });
  socket.on('session-ended', async () => {
    ended = true;
    for (const timer of timers) clearTimeout(timer);
    stream.getTracks().forEach(track => track.stop()); peer?.close();
    destroy(); socket.disconnect(); await window.hostEnded?.();
  });
  window.hostReady = true;
}
