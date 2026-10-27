// The owned streaming page joins its parent recording, without another login/session.
try {
  const config = await (await fetch('/api/repro-frame-config')).json();
  if (config.enabled) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/repro/browser.js';
      script.onload = resolve; script.onerror = reject; document.head.append(script);
    });
    window.reproFrame = ReproBrowser.initReproFrame({ parentOrigin: config.parentOrigin, videoSelector: '#stream' });
  }
} catch { console.warn('[Repro] Player capture is unavailable; streaming remains active.'); }
