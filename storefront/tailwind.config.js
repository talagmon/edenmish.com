/** EdenMish v2 — Tailwind config (merged SUPERSET of all 7 Stitch comps).
 *
 *  Comps 1-4 (edenmish_final_{1,2,3,4}) define the CANONICAL dark palette
 *    (matches design/DESIGN.md).
 *  Comps 5-7 (... 5/{edenmish_canonical_1, edenmish_canonical_2, edenmish_otp_gate})
 *    add status-* colors, accent-purple-light, surface-glass/deep, glass-white,
 *    and extra spacing tokens.
 *  Where comps 5-7 diverge (surface/surface-dim/background = #161218,
 *    tertiary-container = #583f00), the CANONICAL value (#0b1326 / #5500bc) wins.
 *  Source of truth for tokens: design/DESIGN.md.
 *
 *  v2.1 — Design refresh: softer purple (#8B5CF6), improved hierarchy,
 *  lighter glass surface, better contrast. See design feedback in docs/. */

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./public/**/*.html", "./public/**/*.js"],
  theme: {
    extend: {
      colors: {
        // ---- Background hierarchy ----
        "background": "#0F172A",
        "surface-deep": "#0F172A",
        "surface-dim": "#0F172A",
        "surface": "#0F172A",
        "surface-container-lowest": "#0A0F1F",
        "surface-container-low": "#131B2E",
        "surface-container": "#1B2335",
        "surface-container-high": "#222C42",
        "surface-container-highest": "#232E45",
        "surface-bright": "#2D3A55",
        "surface-variant": "#232E45",

        // ---- Purple accent (Option 1 — softer lavender) ----
        "primary": "#8B5CF6",
        "surface-tint": "#8B5CF6",
        "primary-fixed-dim": "#9F67FF",
        "primary-fixed": "#C4B5FD",
        "inverse-primary": "#7C3AED",
        "primary-container": "rgba(139, 92, 246, 0.15)",
        "on-primary": "#F8FAFC",
        "on-primary-container": "#B794F6",
        "on-primary-fixed": "#0F172A",
        "on-primary-fixed-variant": "#7C3AED",
        "accent-purple-light": "#9F67FF",

        // ---- Mint secondary (kept — user likes it) ----
        "secondary": "#91d3c8",
        "secondary-fixed-dim": "#91d3c8",
        "secondary-fixed": "#acefe4",
        "secondary-container": "#00644C",
        "on-secondary": "#003732",
        "on-secondary-container": "#83c4ba",
        "on-secondary-fixed": "#00201c",
        "on-secondary-fixed-variant": "#005049",

        // ---- Tertiary (muted lavender) ----
        "tertiary": "#d2bbff",
        "tertiary-fixed-dim": "#d2bbff",
        "tertiary-fixed": "#eaddff",
        "tertiary-container": "#3B1F8A",
        "on-tertiary": "#3f008e",
        "on-tertiary-container": "#bf9fff",
        "on-tertiary-fixed": "#25005a",
        "on-tertiary-fixed-variant": "#5a00c6",

        // ---- Text hierarchy ----
        "on-surface": "#F8FAFC",
        "on-background": "#F8FAFC",
        "on-surface-variant": "#94A3B8",
        "outline": "#64748B",
        "outline-variant": "#475569",
        "inverse-surface": "#dae2fd",
        "inverse-on-surface": "#1A2234",

        // ---- Glass surfaces ----
        "glass-bg": "rgba(255, 255, 255, 0.03)",
        "glass-border": "rgba(255, 255, 255, 0.08)",
        "surface-glass": "rgba(255, 255, 255, 0.04)",
        "glass-white": "#F8FAFC",

        // ---- Status colors ----
        "success-mint": "#4ADE80",
        "status-delivered": "#4ADE80",
        "status-progress": "#FBBF24",
        "alert-amber": "#FBBF24",
        "error": "#F87171",
        "status-alert": "#F87171",
        "error-container": "#7F1D1D",
        "on-error-container": "#FEE2E2",
        "on-error": "#FEE2E2"
      },
      boxShadow: {
        'purple-glow': '0 0 20px rgba(139, 92, 246, 0.25)',
        'purple-glow-hover': '0 0 30px rgba(139, 92, 246, 0.35)',
        'mint-glow': '0 0 20px rgba(145, 211, 200, 0.2)',
      },
      borderRadius: {
        DEFAULT: "0.25rem",
        lg: "0.5rem",
        xl: "0.75rem",
        full: "9999px"
      },
      spacing: {
        unit: "4px",
        "stack-sm": "8px",
        "stack-md": "16px",
        "container-max": "1200px",
        "gutter-desktop": "24px",
        "stack-lg": "32px",
        "gutter-mobile": "16px",
        "margin-mobile": "16px",
        base: "8px",
        gutter: "24px",
        "margin-desktop": "40px",
        "4.5": "1.125rem"
      },
      maxWidth: {
        "container-max": "1200px"
      },
      fontFamily: {
        "display-lg": ["Hanken Grotesk"],
        "body-md": ["Hanken Grotesk"],
        "headline-md": ["Hanken Grotesk"],
        "headline-lg-mobile": ["Hanken Grotesk"],
        "body-lg": ["Hanken Grotesk"],
        "label-sm": ["Hanken Grotesk"],
        "label-bold": ["Hanken Grotesk"],
        "headline-lg": ["Hanken Grotesk"]
      },
      fontSize: {
        "display-lg": ["48px", { lineHeight: "56px", letterSpacing: "-0.02em", fontWeight: "800" }],
        "body-md": ["16px", { lineHeight: "24px", fontWeight: "400" }],
        "headline-md": ["24px", { lineHeight: "32px", fontWeight: "600" }],
        "headline-lg-mobile": ["28px", { lineHeight: "36px", fontWeight: "700" }],
        "body-lg": ["18px", { lineHeight: "28px", fontWeight: "400" }],
        "label-sm": ["12px", { lineHeight: "16px", fontWeight: "500" }],
        "label-bold": ["14px", { lineHeight: "20px", fontWeight: "700" }],
        "headline-lg": ["32px", { lineHeight: "40px", letterSpacing: "-0.01em", fontWeight: "700" }]
      }
    }
  },
  plugins: [require("@tailwindcss/forms"), require("@tailwindcss/container-queries")]
};