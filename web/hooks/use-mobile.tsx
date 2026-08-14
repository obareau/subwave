import { useMediaQuery } from "usehooks-ts"

const MOBILE_BREAKPOINT = 768

// initializeWithValue: false keeps the SSR discipline the hand-rolled version
// had — false on the server and the first client render, real value after
// mount — so hydration never sees two different trees.
export function useIsMobile() {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`, {
    initializeWithValue: false,
  })
}
