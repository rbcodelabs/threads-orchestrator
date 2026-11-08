/** Runs every teardown step in order; one throwing step cannot skip the rest. Errors are reported, not rethrown. */
export function runAllSafely(steps: ReadonlyArray<() => void>, onError: (error: unknown) => void): void {
  for (const step of steps) {
    try { step(); } catch (error) { onError(error); }
  }
}
