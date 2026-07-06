import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        // LucidCarat brand palette
        lc: {
          bg:           "#FFFFFF",
          surface:      "#F5F7FA",
          border:       "#E2E8F0",
          blue:         "#2563EB",
          "blue-light": "#3B82F6",
          "blue-dark":  "#1D4ED8",
          text:         "#0F172A",
          muted:        "#64748B",
          emerald:      "#16A34A",
        },
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
