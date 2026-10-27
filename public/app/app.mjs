lucide.createIcons();
const $ = selector => document.querySelector(selector);
const euro = cents => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
let active, timer, playerOrigin, games = [], disposed = false;
const currentPlayer = () => $('#player-container iframe:not([data-retiring])');
function clearPlayer() {
  for (const child of $('#player-container').children) if (!child.hasAttribute('data-retiring')) child.remove();
}
function retirePlayer(sessionId) {
  const iframe = currentPlayer();
  if (!iframe) return;
  // Keep the original browsing context alive while capture drains, without
  // delaying settlement or preventing another game from launching.
  iframe.dataset.retiring = 'true'; iframe.hidden = true;
  const done = () => { clearTimeout(deadline); window.removeEventListener('message', receive); iframe.remove(); };
  const receive = event => {
    if (event.source === iframe.contentWindow && event.origin === playerOrigin
      && event.data?.type === 'stream-ended' && event.data.sessionId === sessionId) done();
  };
  const deadline = setTimeout(done, 65000);
  window.addEventListener('message', receive);
  iframe.contentWindow.postMessage({ type: 'end-stream', sessionId }, playerOrigin);
}
const text = (tag, value, className) => { const el = document.createElement(tag); el.textContent = value; if (className) el.className = className; return el; };
async function api(path, body, token) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? 'Request failed');
  return value;
}
async function history() {
  const rows = await api('/api/sessions');
  $('#sessions').replaceChildren(...rows.map(row => {
    const tr = document.createElement('tr');
    tr.append(text('td', games.find(game => game.id === row.game_id)?.title ?? row.game_id), text('td', new Date(row.created_at).toLocaleTimeString()),
      text('td', row.actual_quality ?? row.requested_quality));
    const status = document.createElement('td'); status.append(text('span', row.state, `status ${row.state}`));
    tr.append(status, text('td', row.settlement ? euro(row.settlement.chargedCents) : '-'));
    return tr;
  }));
  if (!rows.length) { const tr = document.createElement('tr'); const td = text('td', 'Your first session is one launch away.'); td.colSpan = 5; tr.append(td); $('#sessions').append(tr); }
}
async function poll() {
  if (!active || disposed) return;
  const current = active;
  try {
    const session = await api(`/api/sessions/${current.id}`, null, current.playerToken);
    if (active !== current) return;
    $('#session-label').textContent = `${session.state} / ${session.id.slice(0, 8)}`;
    if (session.state === 'failed') {
      retirePlayer(current.id);
      $('#message').textContent = session.error_message;
      $('#active').hidden = true; $('#launch').disabled = false; active = null;
      await history(); return;
    }
    if (session.state === 'streaming' && !currentPlayer()) {
      const iframe = document.createElement('iframe');
      const params = new URLSearchParams({ session: current.id, token: current.playerToken, scenario: session.scenario, game: session.game_id, parent: location.origin });
      iframe.src = `${playerOrigin}/#${params}`;
      iframe.title = 'Live game stream'; iframe.allow = 'autoplay; fullscreen';
      clearPlayer(); $('#player-container').append(iframe);
      $('#quality-label').textContent = `Requested: ${session.requested_quality} / Allocated: ${session.actual_quality}`;
    }
  } catch (error) { $('#message').textContent = error.message; }
  if (active && !disposed) timer = setTimeout(poll, 500);
}
$('#launch').addEventListener('click', async () => {
  $('#launch').disabled = true; $('#message').textContent = ''; $('#receipt').hidden = true;
  try {
    active = await api('/api/launch', { gameId: $('#game').value, quality: $('#quality').value, scenario: $('#scenario').value });
    $('#active-title').textContent = games.find(game => game.id === active.game_id)?.title ?? 'Game stream';
    $('#active').hidden = false;
    clearPlayer(); $('#player-container').append(text('div', 'Preparing your stream', 'waiting'));
    $('#stream-status').textContent = 'Connecting';
    $('#active').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await poll(); await history();
  } catch (error) { $('#message').textContent = error.message; $('#launch').disabled = false; }
});
$('#end').addEventListener('click', async () => {
  if (!active) return;
  $('#end').disabled = true;
  try {
    const current = active;
    const session = await api(`/api/sessions/${current.id}/finish`, {}, current.playerToken);
    retirePlayer(current.id);
    clearTimeout(timer); active = null;
    clearPlayer(); $('#active').hidden = true; $('#launch').disabled = false;
    if (session.settlement) {
      const s = session.settlement;
      const amount = text('div', 'Session total', 'receipt-label'); amount.append(text('strong', euro(s.chargedCents), 'receipt-total'));
      const detail = text('div', `${s.billedMinutes} minute(s) at ${euro(s.appliedRate)} / minute`, 'receipt-detail');
      detail.append(text('div', `Contract total: ${euro(s.contractCents)}`));
      if (s.chargedCents !== s.contractCents) detail.append(text('div', `${euro(s.chargedCents - s.contractCents)} above your contracted rate`, 'receipt-alert'));
      $('#receipt').replaceChildren(amount, detail); $('#receipt').hidden = false;
    }
    await history();
  } catch (error) { $('#message').textContent = error.message; }
  finally { $('#end').disabled = false; }
});
$('#refresh').addEventListener('click', () => history().catch(error => { $('#message').textContent = error.message; }));
window.addEventListener('message', event => {
  const iframe = currentPlayer();
  if (!active || event.source !== iframe?.contentWindow || event.origin !== playerOrigin || event.data?.sessionId !== active.id) return;
  if (event.data.type === 'stream-status') $('#stream-status').textContent = event.data.state === 'live' ? 'Live' : event.data.status;
  if (event.data.type === 'stream-connected') $('#stream-status').textContent = 'Connected';
  if (event.data.type === 'stream-stats') $('#stream-status').textContent = event.data.stats.stalled ? 'Stream interrupted' : 'Live';
});
window.addEventListener('pagehide', () => { disposed = true; clearTimeout(timer); });
try {
  const config = await api('/api/catalog'); playerOrigin = config.playerOrigin;
  games = config.games;
  for (const game of games) $('#game').add(new Option(game.title, game.id));
  const selectGame = () => {
    const game = games.find(game => game.id === $('#game').value);
    $('#game-title').textContent = game.title; $('#game-category').textContent = game.category;
    $('#game-description').textContent = game.description;
    $('.art-caption h2').textContent = game.title;
    $('.art-caption span').textContent = game.studio;
    $('.art-caption p').textContent = game.category;
    $('#cover').hidden = game.id !== 'circuit';
    $('.game-art').style.backgroundImage = game.id === 'bananabread' ? 'url(/bananabread.jpg)' : '';
    $('.game-art').style.backgroundSize = 'cover';
    $('.game-art').style.backgroundPosition = 'center';
    $('.game-art').setAttribute('aria-label', `${game.title} gameplay`);
  };
  $('#game').addEventListener('change', selectGame); selectGame();
  for (const [value, title] of Object.entries(config.scenarios)) $('#scenario').add(new Option(title, value));
  await history();
} catch (error) { $('#message').textContent = error.message; }

// The cover uses the same circuit geometry as the streamed game.
const c = $('#cover'), g = c.getContext('2d');
g.fillStyle = '#173429'; g.fillRect(0, 0, c.width, c.height);
g.strokeStyle = '#294936'; g.lineWidth = 1;
for (let i = 0; i < c.width; i += 40) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, c.height); g.stroke(); }
for (let i = 0; i < c.height; i += 40) { g.beginPath(); g.moveTo(0, i); g.lineTo(c.width, i); g.stroke(); }
g.translate(530, 260); g.rotate(-.22);
g.fillStyle = '#41584c'; g.beginPath(); g.roundRect(-480, -210, 970, 420, 180); g.fill();
g.strokeStyle = '#b7d994'; g.lineWidth = 5; g.stroke();
g.fillStyle = '#173429'; g.beginPath(); g.roundRect(-285, -75, 550, 160, 75); g.fill();
g.strokeStyle = '#789272'; g.lineWidth = 3; g.stroke();
for (let y = -205; y < -75; y += 16) for (let x = 0; x < 48; x += 16) { g.fillStyle = ((y + 205) / 16 + x / 16) % 2 ? '#f0eee0' : '#25392d'; g.fillRect(x, y, 16, 16); }
g.fillStyle = '#b8e97c'; g.beginPath(); g.roundRect(180, -170, 85, 42, 10); g.fill();
g.fillStyle = '#1b3437'; g.beginPath(); g.roundRect(202, -165, 32, 32, 5); g.fill();
g.fillStyle = '#fff6d3'; g.fillRect(257, -163, 4, 8); g.fillRect(257, -141, 4, 8);
