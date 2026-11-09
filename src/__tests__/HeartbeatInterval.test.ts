import { describe, expect, it } from 'vitest';
import { heartbeatIntervalMs } from '../HeartbeatService';

describe('heartbeatIntervalMs', () => {
  it('uses the default for non-numbers, clamps below 5 up to 5, above 1440 down to 1440', () => {
    expect(heartbeatIntervalMs(undefined)).toBe(60 * 60_000);
    expect(heartbeatIntervalMs(Number.NaN)).toBe(60 * 60_000);
    expect(heartbeatIntervalMs(1)).toBe(5 * 60_000);
    expect(heartbeatIntervalMs(30)).toBe(30 * 60_000);
    expect(heartbeatIntervalMs(99999)).toBe(1440 * 60_000);
  });
});
