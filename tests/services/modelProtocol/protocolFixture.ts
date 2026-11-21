import { beforeEach, vi } from 'vitest';

export const jsonResponse = (
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
});

export function setupProtocolFixture() {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
}
