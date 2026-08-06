'use client';

import { useCallback, useEffect, useState } from 'react';
import { applyLite, loadLitePref, saveLitePref } from '@/lib/lite';

export interface LiteModeState {
  /** Whether low-power mode is active (blur + animations dropped). */
  lite: boolean;
  /** Set the mode explicitly and sync the <html> class + localStorage. */
  setLite: (on: boolean) => void;
}

/** Listener-facing low-power toggle. LITE_INIT_SCRIPT already applies the `lite`
 *  class pre-paint, so this only surfaces the value and keeps the class +
 *  localStorage in sync when the listener flips it. */
export function useLiteMode(): LiteModeState {
  const [lite, setLiteState] = useState(false);

  // localStorage is only safe to read in an effect. The pre-paint script already
  // set the class, so the one-tick lag here is invisible (the menu starts closed).
  useEffect(() => {
    setLiteState(loadLitePref() === true);
  }, []);

  const setLite = useCallback((on: boolean) => {
    saveLitePref(on);
    applyLite(on);
    setLiteState(on);
  }, []);

  return { lite, setLite };
}
