import { channel } from 'node:diagnostics_channel';

// Versioned transport hooks are optional: SDK-off jobs keep the same arguments,
// return values, errors and lease semantics. No business handler imports Repro.
export function enqueueContext() {
  const event = {};
  channel('repro.jobs.v1.enqueue').publish(event);
  return event.captureContext ?? null;
}

export function dispatchJob(job, handler) {
  const event = { name: handler.name || 'job', captureContext: job.capture_context ?? undefined,
    handler, args: [job], invoke: () => handler(job) };
  channel('repro.jobs.v1.dispatch').publish(event);
  return event.invoke();
}

export function startJobPolling({ next, process: handler, onError, intervalMs = 500, available = () => true }) {
  let stopped = false, pending;
  const poll = async () => {
    if (stopped || pending || !available()) return;
    pending = (async () => {
      const job = await next();
      if (job) return dispatchJob(job, handler);
    })();
    try { await pending; } catch (error) { onError(error); } finally { pending = null; }
  };
  // The dispatched job, not each empty poll, is the unit of execution.
  const timer = setInterval(() => { void poll(); }, intervalMs);
  return { async close() { stopped = true; clearInterval(timer); await pending?.catch(() => {}); } };
}
