// SDK initialization only; business actions, routes and job handlers contain no Repro calls.
try {
  const response = await fetch('/api/repro-config');
  const config = await response.json();
  if (config.enabled) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/repro/browser.js';
      script.onload = resolve; script.onerror = reject; document.head.append(script);
    });
    window.repro = ReproBrowser.initReproBrowser(config.options);
    void window.repro.ready.catch(error => console.warn('[Repro]', error.message));
  }
} catch (error) { console.warn('[Repro] Capture initialization failed; gameplay remains available.', error.message); }
