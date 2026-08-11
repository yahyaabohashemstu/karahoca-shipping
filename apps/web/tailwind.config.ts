import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        signal: {
          live: '#16a34a',
          delayed: '#f59e0b',
          stale: '#f97316',
          lost: '#dc2626',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
