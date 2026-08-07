// Charts must recolor the moment the theme changes. useSyncExternalStore keeps
// the read out of the render phase and re-renders every consumer on both the
// explicit toggle and an OS-level light/dark switch.

import { useSyncExternalStore } from "react";
import { isDark, subscribeTheme } from "./palette";

// Module-level identities: inline arrows would be new functions on every
// render, making React tear down and re-add the listeners each time.
const subscribe = (onChange: () => void) => subscribeTheme(onChange);
const getSnapshot = () => isDark();
const getServerSnapshot = () => true;

export function useIsDark(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
