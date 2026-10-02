import { type ShareLink } from '@expo/hub-components';

declare global {
  interface Window {
    __EXPO_DEVICE_HUB_SESSION_TOKEN__?: string;
    __EXPO_DEVICE_HUB_SHARE_URL__?: string;
  }
}

type ShareLocation = Pick<Location, 'origin' | 'pathname' | 'search'>;

/**
 * The link the Share button copies: `--share-url`, or this page. Under `--require-token` it
 * carries the session token, which the Hub trades for a cookie on the first load.
 */
export function shareLink(
  location: ShareLocation,
  { sessionToken, shareUrl }: { sessionToken?: string; shareUrl?: string }
): ShareLink {
  const url = shareUrl ? new URL(shareUrl) : new URL(location.pathname + location.search, location.origin);
  url.searchParams.delete('token');
  if (sessionToken) url.searchParams.set('token', sessionToken);
  return { url: url.toString(), carriesToken: !!sessionToken };
}

/** The share link for this dashboard, from the values the standalone CLI injected. */
export function dashboardShareLink(): ShareLink {
  return shareLink(window.location, {
    sessionToken: window.__EXPO_DEVICE_HUB_SESSION_TOKEN__,
    shareUrl: window.__EXPO_DEVICE_HUB_SHARE_URL__,
  });
}
