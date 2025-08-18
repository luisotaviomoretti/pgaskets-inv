import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: 'src/__tests__/setupTests.ts',
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
