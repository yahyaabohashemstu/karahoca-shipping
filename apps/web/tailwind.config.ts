import type { Config } from 'tailwindcss';

/**
 * Every colour resolves through a CSS custom property defined in globals.css,
 * so `bg-surface` means "whatever surface is in the active theme" rather than
 * a fixed hex. That is what makes the dark theme a `data-theme` attribute
 * rather than a second set of classes on every element.
 *
 * The `<alpha-value>` placeholder is what keeps `/50` opacity modifiers
 * working; a bare `var(--x)` would break them silently.
 */
const rgb = (v: string) => `rgb(var(--kh-${v}) / <alpha-value>)`;

export default {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: rgb('bg'),
        surface: {
          DEFAULT: rgb('surface'),
          2: rgb('surface-2'),
          3: rgb('surface-3'),
        },
        line: {
          DEFAULT: rgb('border'),
          strong: rgb('border-strong'),
        },
        ink: {
          DEFAULT: rgb('text'),
          2: rgb('text-2'),
          3: rgb('text-3'),
          inverse: rgb('text-inverse'),
        },
        brand: {
          DEFAULT: rgb('brand'),
          hover: rgb('brand-hover'),
          soft: rgb('brand-soft'),
          text: rgb('brand-text'),
        },
        danger: {
          DEFAULT: rgb('danger'),
          bg: rgb('danger-bg'),
          ring: rgb('danger-ring'),
        },
        success: { DEFAULT: rgb('success'), bg: rgb('success-bg') },
        warn: { DEFAULT: rgb('warn'), bg: rgb('warn-bg') },

        // The five signal states, each with its own text / fill / ring triple.
        live: { DEFAULT: rgb('live'), bg: rgb('live-bg'), ring: rgb('live-ring') },
        delayed: { DEFAULT: rgb('delayed'), bg: rgb('delayed-bg'), ring: rgb('delayed-ring') },
        stale: { DEFAULT: rgb('stale'), bg: rgb('stale-bg'), ring: rgb('stale-ring') },
        lost: { DEFAULT: rgb('lost'), bg: rgb('lost-bg'), ring: rgb('lost-ring') },
        nosignal: { DEFAULT: rgb('nosignal'), ring: rgb('nosignal-ring') },
        paused: { DEFAULT: rgb('paused'), bg: rgb('paused-bg'), ring: rgb('paused-ring') },
      },

      /*
       * A 14px root means these rem values are all smaller than their Tailwind
       * defaults. That is the point: this is an operations console, and the
       * stock scale wastes roughly a third of the vertical space on a list a
       * dispatcher needs to scan forty rows of.
       */
      fontSize: {
        '2xs': ['0.7143rem', { lineHeight: '1rem', letterSpacing: '0.01em' }],   // 10px
        xs: ['0.7857rem', { lineHeight: '1.1429rem' }],                          // 11px
        sm: ['0.8571rem', { lineHeight: '1.2857rem' }],                          // 12px
        base: ['1rem', { lineHeight: '1.4286rem' }],                             // 14px
        md: ['1.1429rem', { lineHeight: '1.5714rem' }],                          // 16px
        lg: ['1.2857rem', { lineHeight: '1.7143rem', letterSpacing: '-0.01em' }],// 18px
        xl: ['1.5714rem', { lineHeight: '2rem', letterSpacing: '-0.015em' }],    // 22px
        '2xl': ['2rem', { lineHeight: '2.4286rem', letterSpacing: '-0.02em' }],  // 28px
        '3xl': ['2.5714rem', { lineHeight: '3rem', letterSpacing: '-0.025em' }], // 36px
      },

      fontFamily: {
        /*
         * Interleaved by face name, not by next/font's CSS variables, and the
         * reason is worth the paragraph.
         *
         * A browser walks this list per character and skips any face whose
         * unicode-range excludes it. Two facts make the obvious orderings wrong:
         *
         *   var(--font-inter) expands to `Inter, "Inter Fallback"`, and that
         *   generated fallback is a metric-adjusted local("Arial") carrying NO
         *   unicode-range. It matches Arabic. Put the variable first and Arabic
         *   renders in Arial wearing Inter's metrics, with the correct face
         *   loaded and unused.
         *
         *   Noto Sans Arabic's webfont is not Arabic-only — Google subsets it
         *   with U+0000-00FF and U+0100-02BA as well. Put it first and every
         *   Latin word on the dashboard, in all three languages, silently moves
         *   off Inter.
         *
         * Naming the four faces directly threads between both. Latin takes
         * Inter, Arabic falls past Inter's ranges to Noto, and each keeps its
         * own metric-adjusted fallback for the window before it loads. The
         * @font-face rules are global once next/font has emitted them, so the
         * variables are no longer needed here — only on <html>, which is where
         * they still are.
         */
        sans: [
          'Inter',
          'Noto Sans Arabic',
          'Inter Fallback',
          'Noto Sans Arabic Fallback',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'sans-serif',
        ],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
      },

      borderRadius: {
        sm: '0.25rem',
        DEFAULT: '0.375rem',
        md: '0.5rem',
        lg: '0.625rem',
        xl: '0.875rem',
      },

      boxShadow: {
        // Shadows are tinted with the theme's shadow colour so they read as
        // depth in light mode and as a soft halo in dark mode, instead of the
        // invisible pure-black blur that Tailwind's defaults give you.
        xs: '0 1px 2px 0 rgb(var(--kh-shadow) / 0.06)',
        sm: '0 1px 3px 0 rgb(var(--kh-shadow) / 0.08), 0 1px 2px -1px rgb(var(--kh-shadow) / 0.06)',
        md: '0 4px 12px -2px rgb(var(--kh-shadow) / 0.10), 0 2px 4px -2px rgb(var(--kh-shadow) / 0.06)',
        lg: '0 12px 28px -6px rgb(var(--kh-shadow) / 0.16), 0 4px 8px -4px rgb(var(--kh-shadow) / 0.08)',
        panel: '0 10px 34px -8px rgb(var(--kh-shadow) / 0.22)',
      },

      transitionDuration: { DEFAULT: '140ms' },
      transitionTimingFunction: { DEFAULT: 'cubic-bezier(0.2, 0, 0.2, 1)' },
    },
  },
  plugins: [],
} satisfies Config;
