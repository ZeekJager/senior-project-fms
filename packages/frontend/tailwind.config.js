/** @type {import('tailwindcss').Config} */

// Colours are CSS variables (src/index.css) holding "R G B" channels, so one
// class works in light and dark mode and opacity modifiers still apply
// (`bg-brand/10`). See docs/design-system.md.
const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        canvas: token('canvas'),
        surface: {
          DEFAULT: token('surface'),
          muted: token('surface-muted'),
          sunken: token('surface-sunken'),
        },
        line: {
          DEFAULT: token('line'),
          strong: token('line-strong'),
        },
        ink: {
          DEFAULT: token('ink'),
          muted: token('ink-muted'),
          subtle: token('ink-subtle'),
        },
        // brand: solid fills under white text; brand-ink: accent text and icons on surfaces.
        brand: {
          DEFAULT: token('brand'),
          strong: token('brand-strong'),
          soft: token('brand-soft'),
          ink: token('brand-ink'),
        },
        overlay: token('overlay'),
        success: { DEFAULT: token('success'), soft: token('success-soft') },
        warning: { DEFAULT: token('warning'), soft: token('warning-soft') },
        danger: { DEFAULT: token('danger'), soft: token('danger-soft'), solid: token('danger-solid') },
        info: { DEFAULT: token('info'), soft: token('info-soft') },
        neutral: { DEFAULT: token('neutral'), soft: token('neutral-soft') },
        // Kept for screens written before the design system (FMS-10).
        'fms-primary': token('brand-ink'),
        'fms-danger': token('danger'),
        'fms-warning': token('warning'),
        'fms-success': token('success'),
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      fontSize: {
        // 12px is the smallest text in the app (badges, captions).
        '2xs': ['0.75rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        // Controls 12px, cards 16px, sheets 20px.
        control: '12px',
        card: '16px',
        sheet: '20px',
      },
      boxShadow: {
        soft: '0 1px 2px rgb(var(--shadow) / 0.05), 0 1px 3px rgb(var(--shadow) / 0.07)',
        card: '0 1px 2px rgb(var(--shadow) / 0.04), 0 4px 16px -4px rgb(var(--shadow) / 0.09)',
        elevated: '0 24px 48px -12px rgb(var(--shadow) / 0.24), 0 8px 16px -8px rgb(var(--shadow) / 0.10)',
        glow: '0 8px 24px -8px rgb(var(--c-brand) / 0.55)',
        focus: '0 0 0 4px rgb(var(--c-brand) / 0.18)',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'scale-in': {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'slide-in-right': { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
        'slide-in-left': { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(0)' } },
        'pop-in': {
          from: { opacity: '0', transform: 'translateY(-4px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'toast-in': {
          from: { opacity: '0', transform: 'translateY(16px) scale(0.96)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 200ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        'scale-in': 'scale-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        'slide-in-right': 'slide-in-right 320ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        'slide-in-left': 'slide-in-left 280ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        'pop-in': 'pop-in 160ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        shimmer: 'shimmer 1.6s infinite',
        'toast-in': 'toast-in 260ms cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
    },
  },
  plugins: [],
}
