import { expect, it, vi } from 'vitest';
import { runAllSafely } from '../SafeTeardown';
import { ServiceLifecycle } from '../ServiceLifecycle';
import { REQUIRED_CORE_CAPABILITIES, type ClaudeThreadsApiV1 } from '../ClaudeThreadsApiTypes';

it('a throwing controller.destroy() still stops the orchestration services, and later steps still run', () => {
  const stop = vi.fn();
  const api = { apiVersion: 1, generation: 'g', capabilities: REQUIRED_CORE_CAPABILITIES } as unknown as ClaudeThreadsApiV1;
  const lifecycle = new ServiceLifecycle({ client: { current: () => api, onChange: () => () => {} }, label: 'x', isEnabled: () => true, createService: () => ({ start() {}, stop }) });
  lifecycle.start();
  const later = vi.fn(); const onError = vi.fn();
  // Same ordering main.ts onunload uses: orchestration services first, then the rest.
  runAllSafely([() => lifecycle.dispose(), () => { throw new Error('destroy failed'); }, later], onError);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(later).toHaveBeenCalled();
  expect(onError).toHaveBeenCalledTimes(1);
});
