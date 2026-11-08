import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadSerif } from "@remotion/google-fonts/InstrumentSerif";

/** Kestrel's three families (src/app/layout.tsx): Instrument Serif, Inter, JetBrains Mono. */
export const sans = loadInter("normal", { weights: ["300", "400", "500", "600", "700"], subsets: ["latin"] }).fontFamily;
export const mono = loadMono("normal", { weights: ["400", "500", "700"], subsets: ["latin"] }).fontFamily;
export const serif = loadSerif("normal", { weights: ["400"], subsets: ["latin"] }).fontFamily;
loadSerif("italic", { weights: ["400"], subsets: ["latin"] });

/** Kestrel's tokens, from src/app/globals.css. */
export const C = {
  bg: "#07090D",
  surface: "#0C1017",
  elevated: "#121822",
  hair: "rgba(255,255,255,0.08)",
  hair2: "rgba(255,255,255,0.16)",
  ink: "#F3F6FA",
  ink2: "#9BA7B8",
  ink3: "#5F6B7C",
  meta: "#7D8899",
  phos: "#91D982",
  base: "#38BDF8",
  rh: "#C8FF00",
  warn: "#FFB020",
  crit: "#FF4D4F",
  paper: "#EEF1EC",
  paperInk: "#07090D",
  paperMuted: "#4C5563",
};

export type Tone = "dark" | "light" | "brand";
export const TONE: Record<Tone, { bg: string; ink: string; muted: string; line: string; pill: string }> = {
  dark: { bg: C.bg, ink: C.ink, muted: "rgba(243,246,250,0.55)", line: "rgba(255,255,255,0.12)", pill: "rgba(7,9,13,0.66)" },
  light: { bg: C.paper, ink: C.paperInk, muted: "rgba(7,9,13,0.5)", line: "rgba(7,9,13,0.12)", pill: "rgba(255,255,255,0.82)" },
  brand: { bg: C.phos, ink: C.paperInk, muted: "rgba(7,9,13,0.6)", line: "rgba(7,9,13,0.2)", pill: "rgba(240,255,235,0.6)" },
};

export const SCENE_TONE: Record<string, Tone> = {
  open: "dark", problem: "light", evidence: "dark", turn: "brand", briefing: "dark", pager: "dark",
  rescue: "dark", lab: "dark", shield: "light", agents: "dark", hood: "dark", different: "brand", close: "dark",
};
