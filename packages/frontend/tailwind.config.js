/** @type {import('tailwindcss').Config} */

// Colours are CSS variables (src/index.css) holding "R G B" channels, so one
// class works in light and dark mode and opacity modifiers still apply
// (`bg-brand/10`). See docs/design-system.md.
const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
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
        side: { DEFAULT: token('side'), line: token('side-line'), ink: token('side-ink'), active: token('side-active') },
        focus: token('focus'),
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
        // Ethiopic falls back to a system face that has the glyphs (Inter has none).
        sans: ['"Inter Variable"', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', '"Noto Sans Ethiopic"', 'Nyala', 'sans-serif'],
      },
      fontSize: {
        // Type roles: 2xs 12px uppercase group labels; xs 13px captions, table headers, badges; sm 14px body and data;
        // plate 15px (the plate role, see .plate); xl and 2xl page titles. Nothing below 12px.
        '2xs': ['0.75rem', { lineHeight: '1rem' }],
        xs: ['0.8125rem', { lineHeight: '1.125rem' }],
      },
      borderRadius: {
        // Controls 8px, cards 12px, sheets 16px.
        control: '8px',
        card: '12px',
        sheet: '16px',
      },
      boxShadow: {
        soft: '0 1px 2px rgb(var(--shadow) / 0.06)',
        card: '0 1px 2px rgb(var(--shadow) / 0.04)',
        elevated: '0 16px 40px -12px rgb(var(--shadow) / 0.28), 0 4px 12px -4px rgb(var(--shadow) / 0.12)',
        focus: '0 0 0 3px rgb(var(--c-brand) / 0.25)',
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
  // Touch devices get 44px targets (`coarse:`) without making the desktop layout looser.
  future: { hoverOnlyWhenSupported: true },
  plugins: [
    ({ addVariant }) => {
      addVariant('coarse', '@media (pointer: coarse)')
    },
  ],
}
