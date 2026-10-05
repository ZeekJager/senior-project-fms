/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // FMS design tokens: use as bg-fms-primary, text-fms-danger, etc.
      colors: {
        'fms-primary': '#1d4ed8',
        'fms-danger': '#dc2626',
        'fms-warning': '#d97706',
        'fms-success': '#16a34a',
      },
    },
  },
  plugins: [],
}
