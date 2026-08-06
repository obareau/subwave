// Station password token for private stations (#478).
//
// One shared password backs both privacy locks (privatePlayer, listenerAuth).
// Whichever gate the listener meets first, the password they type is stored
// here and serves the other too.
//
// Browsers can't attach basic-auth credentials to an <audio> element, so the
// stream side rides the token as an `auth=` query param: Icecast's URL auth
// forwards the mount INCLUDING its query string to the controller, which
// accepts either that or a real basic-auth `pass` field.
//
// Stored in localStorage; cleared when the controller rejects it.
const KEY = 'subwave-station-auth';

export function getStationAuthToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}

export function setStationAuthToken(token: string): void {
  try {
    window.localStorage.setItem(KEY, token);
  } catch {
    // Private-mode storage failures just mean re-prompting next visit.
  }
}

export function clearStationAuthToken(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

// No-op when no token is stored (the common public-station case). Player URLs
// already carry a ?t= cache-buster, but handle both shapes.
export function withStreamAuth(url: string): string {
  const token = getStationAuthToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}auth=${encodeURIComponent(token)}`;
}

// Deliberately hits /station-auth, NOT the /listener-auth endpoint Icecast
// calls. They share the password but not the failure mode: /listener-auth fails
// OPEN when stream auth is off, covering the window where icecast.xml still
// carries the auth blocks but the setting is already off. Asking it here would
// mean a private player with stream auth off accepts any password.
// /station-auth fails closed.
export async function checkStationAuth(apiBase: string, password: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/station-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
