import { fork } from 'node:child_process';
import { once } from 'node:events';

export async function forkAgent(config) {
  const origin = config.apiOrigin || config.appOrigin;
  const child = fork(new URL('./agent-process.mjs', import.meta.url), [], {
    env: { ...process.env, YOM_AZURE_ORIGIN: origin }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Streaming agent startup timed out.')); }, 30_000);
    const onExit = code => { clearTimeout(timeout); reject(new Error(`Agent exited during startup: ${code}`)); };
    child.once('exit', onExit);
    child.once('message', message => {
      clearTimeout(timeout); child.removeListener('exit', onExit);
      if (message.type === 'ready') resolve(); else { child.kill(); reject(new Error(message.message)); }
    });
    child.send({ type: 'start', config: { ...config, appOrigin: origin } });
  });
  return { pid: child.pid, async close() {
    const checkExit = (code, signal) => {
      if (code !== 0 || signal) throw new Error(`Streaming agent shutdown failed (${signal || code}); capture delivery is not confirmed.`);
    };
    if (child.exitCode !== null || child.signalCode !== null) return checkExit(child.exitCode, child.signalCode);
    const exited = once(child, 'exit');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 40_000);
    try { if (child.connected) child.send({ type: 'stop' }); else child.kill(); checkExit(...await exited); }
    finally { clearTimeout(timeout); }
  } };
}
