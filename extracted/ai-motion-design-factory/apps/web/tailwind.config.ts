import type { Config } from "tailwindcss";

/**
 * Design tokens — "broadcast control room" direction (see docs/04 §1.1).
 * Deliberately not the generic near-black + single acid accent: this
 * product visualizes 13 AI agents working like a monitoring wall, so the
 * palette borrows a broadcast tally-light system (red = live, green =
 * ready, amber = awaiting input) instead of one decorative accent color.
 */
const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        void: "#0A0D12",
        panel: "#12161F",
        "panel-raised": "#1A1F2B",
        hairline: "#232935",
        ink: {
          primary: "#E8EAED",
          muted: "#7C8494",
          faint: "#4B5262",
        },
        signal: {
          live: "#FF5D3B", // agent actively running — tally red
          ready: "#34D399", // idle, healthy — tally green
          standby: "#F5B84C", // awaiting human approval — tally amber
          error: "#E5484D", // failed run
        },
        accent: "#4C8DFF", // on-air monitor blue — links, primary actions, focus ring
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "Noto Sans JP", "system-ui", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: {
        DEFAULT: "6px",
      },
      boxShadow: {
        tally: "0 0 0 1px rgba(255,255,255,0.04), 0 8px 24px -8px rgba(0,0,0,0.6)",
      },
      keyframes: {
        pulseTally: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        "pulse-tally": "pulseTally 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
