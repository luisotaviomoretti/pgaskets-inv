import '@testing-library/jest-dom';
import { beforeAll, afterAll, afterEach, vi } from 'vitest';
import { server } from './testServer';

// MSW: start/stop/reset
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Silence React act warnings in tests that use timers
vi.spyOn(console, 'error').mockImplementation((...args) => {
  const msg = args.join(' ');
  if (/Warning:.*not wrapped in act/.test(msg)) return;
  // eslint-disable-next-line no-console
  (console as any).__proto__.error.apply(console, args);
});
