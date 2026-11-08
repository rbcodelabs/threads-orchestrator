import { expect, it, vi } from 'vitest';
import { runAllSafely } from '../SafeTeardown';
import { WakeupLifecycle } from '../WakeupLifecycle';
import type { ClaudeThreadsApiV1 } from '../ClaudeThreadsApiTypes';

it('a throwing controller.destroy() still disposes the wake-up delegate, and later steps still run', () => {
  const delegateDispose = vi.fn();
  const api = {
    apiVersion: 1, generation: 'g', capabilities: ['orchestrators.wakeup.delegate'],
    threads: { subscribe: () => ({ dispose() {} }), get: vi.fn() },
    orchestrators: { list: vi.fn(), dispatch: vi.fn(), delegateWakeup: () => ({ dispose: delegateDispose }) },
  } as unknown as ClaudeThreadsApiV1;
  const lifecycle = new WakeupLifecycle({ client: { current: () => api, onChange: () => () => {} }, pluginId: 'p', isEnabled: () => true });
  lifecycle.start();
  const later = vi.fn(); const onError = vi.fn();
  // Same ordering main.ts onunload uses: wake-up lifecycle first, then the rest.
  runAllSafely([() => lifecycle.dispose(), () => { throw new Error('destroy failed'); }, later], onError);
  expect(delegateDispose).toHaveBeenCalledTimes(1);
  expect(later).toHaveBeenCalled();
  expect(onError).toHaveBeenCalledTimes(1);
});
