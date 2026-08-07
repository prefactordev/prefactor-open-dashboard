// Chart color system — a validated, brand-neutral default palette.
// (Validated for adjacent-pair colorblind separation and surface contrast in
// both modes; swap hexes for your brand's and re-validate before shipping.)
//
// Rules baked into the helpers:
//  - Categorical hues are assigned in FIXED order by entity, never cycled or
//    re-ranked when a filter changes; past 8 series the tail folds into Other.
//  - Status colors (good/warning/serious/critical) are reserved for state —
//    the Risk tab uses them because risk IS state — and never for a series.

// Aqua leads so charts open in Prefactor's green family. This exact ordering
// was machine-validated (adjacent-pair CVD ΔE ≥ 8, normal-vision ΔE ≥ 15,
// lightness band, chroma floor) in light mode on #fcfcfb and dark mode on the
// brand surface #0a1613 — re-run the dataviz palette validator if you reorder.
export const SERIES_LIGHT = ["#1baf7a", "#eb6834", "#2a78d6", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
export const SERIES_DARK = ["#199e70", "#d95926", "#3987e5", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;

export const OTHER_LIGHT = "#898781";
export const OTHER_DARK = "#898781";

export function isDark(): boolean {
  const stamped = document.documentElement.dataset.theme;
  if (stamped === "dark") return true;
  if (stamped === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Broadcast a theme change so charts recolor immediately. */
export const THEME_EVENT = "prefactor-theme-change";

/**
 * Subscribe to the effective theme. Reading isDark() during render meant
 * charts kept the previous palette until some unrelated re-render (up to a
 * sync interval later), and an OS light/dark switch in "auto" mode never
 * propagated at all.
 */
export function subscribeTheme(onChange: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onChange);
  window.addEventListener(THEME_EVENT, onChange);
  return () => {
    media.removeEventListener("change", onChange);
    window.removeEventListener(THEME_EVENT, onChange);
  };
}

/** Series color by fixed slot index; slots past 8 must be folded before this. */
export function seriesColor(slot: number, dark: boolean): string {
  const ramp = dark ? SERIES_DARK : SERIES_LIGHT;
  return ramp[slot] ?? (dark ? OTHER_DARK : OTHER_LIGHT);
}

/**
 * Fixed slot assignment for a set of entities: order by first appearance in
 * the FULL dataset (by total, descending) once, then keep it stable. Returns
 * at most `max` named slots; everything else folds into "Other".
 */
export function assignSlots(entities: string[], max = 6): { named: string[]; other: string[] } {
  return { named: entities.slice(0, max), other: entities.slice(max) };
}

export const RISK_COLOR: Record<string, string> = {
  low: STATUS.good,
  medium: STATUS.warning,
  high: STATUS.serious,
  critical: STATUS.critical,
};

export const RISK_ICON: Record<string, string> = {
  low: "✓",
  medium: "!",
  high: "▲",
  critical: "✕",
};
