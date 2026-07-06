/** EdenMish v2 — Tailwind config (merged SUPERSET of all 7 Stitch comps).
 *
 *  Comps 1-4 (edenmish_final_{1,2,3,4}) define the CANONICAL dark palette
 *    (matches design/DESIGN.md).
 *  Comps 5-7 (... 5/{edenmish_canonical_1, edenmish_canonical_2, edenmish_otp_gate})
 *    add status-* colors, accent-purple-light, surface-glass/deep, glass-white,
 *    and extra spacing tokens.
 *  Where comps 5-7 diverge (surface/surface-dim/background = #161218,
 *    tertiary-container = #583f00), the CANONICAL value (#0b1326 / #5500bc) wins.
 *  Source of truth for tokens: design/DESIGN.md. */

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./public/**/*.html", "./public/**/*.js"],
  theme: {
    extend: {
      colors: {
        // ---- Canonical palette (comps 1-4, matches design/DESIGN.md) ----
        "surface-dim": "#0b1326",
        "on-primary-fixed-variant": "#5f2e8a",
        "on-secondary-fixed-variant": "#005049",
        "surface": "#0b1326",
        "surface-bright": "#31394d",
        "on-primary": "#471272",
        "alert-amber": "#FBBF24",
        "on-background": "#dae2fd",
        "primary": "#dfb7ff",
        "tertiary": "#d2bbff",
        "secondary": "#91d3c8",
        "success-mint": "#34D399",
        "primary-fixed-dim": "#dfb7ff",
        "surface-tint": "#dfb7ff",
        "tertiary-container": "#5500bc",
        "surface-container-high": "#222a3d",
        "secondary-fixed": "#acefe4",
        "tertiary-fixed-dim": "#d2bbff",
        "on-surface": "#dae2fd",
        "surface-container": "#171f33",
        "on-secondary-fixed": "#00201c",
        "on-secondary-container": "#83c4ba",
        "inverse-primary": "#7847a4",
        "on-tertiary-container": "#bf9fff",
        "on-primary-fixed": "#2d004f",
        "secondary-fixed-dim": "#91d3c8",
        "on-error": "#690005",
        "background": "#0b1326",
        "surface-variant": "#2d3449",
        "error": "#ffb4ab",
        "error-container": "#93000a",
        "surface-container-low": "#131b2e",
        "glass-border": "rgba(255, 255, 255, 0.15)",
        "inverse-on-surface": "#283044",
        "surface-container-lowest": "#060e20",
        "primary-container": "#5b2a86",
        "surface-container-highest": "#2d3449",
        "on-error-container": "#ffdad6",
        "on-surface-variant": "#cec3d2",
        "inverse-surface": "#dae2fd",
        "on-primary-container": "#cf9afd",
        "glass-bg": "rgba(255, 255, 255, 0.05)",
        "on-tertiary-fixed": "#25005a",
        "tertiary-fixed": "#eaddff",
        "outline": "#978d9b",
        "primary-fixed": "#f1daff",
        "on-tertiary-fixed-variant": "#5a00c6",
        "on-secondary": "#003732",
        "secondary-container": "#00534b",
        "outline-variant": "#4c4450",
        "on-tertiary": "#3f008e",
        // ---- Added from comps 5-7 (no palette conflict) ----
        "accent-purple-light": "#9d50bb",
        "surface-glass": "rgba(255, 255, 255, 0.04)",
        "surface-deep": "#0b1326",
        "glass-white": "#ffffff",
        "status-alert": "#ef4444",
        "status-progress": "#f59e0b",
        "status-delivered": "#10b981"
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
        // ---- Added from comps 5-7 ----
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
