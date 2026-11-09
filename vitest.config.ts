import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [{ name: 'md-as-text', transform: (code: string, id: string) => id.endsWith('.md') ? { code: `export default ${JSON.stringify(code)}`, map: null } : null }],
  test: {
    environment: 'node',
  },
});
