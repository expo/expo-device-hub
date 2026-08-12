import {
  Button,
  Logo,
  PowerIcon,
  RefreshIcon,
  bg,
  border,
  heading,
  icon,
  radius,
  shadow,
  text,
  textSize,
} from '../primitives';

export type ServerConnectionOverlayProps = {
  status: 'connecting' | 'disconnected';
  onReload: () => void;
};

/** Full-page blocker shown until the dashboard can verify its dev server connection. */
export function ServerConnectionOverlay({ status, onReload }: ServerConnectionOverlayProps) {
  const connecting = status === 'connecting';

  return (
    <main
      aria-busy={connecting}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        minWidth: 0,
        minHeight: '100vh',
        padding: 24,
        backgroundColor: bg.screen,
        color: text.default,
        fontFamily: 'var(--expo-font-sans)',
      }}>
      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          width: '100%',
          maxWidth: 440,
          padding: '40px 32px',
          boxSizing: 'border-box',
          backgroundColor: bg.default,
          border: `1px solid ${border.secondary}`,
          borderRadius: radius.xl,
          boxShadow: shadow.sm,
          textAlign: 'center',
        }}>
        <Logo style={{ marginBottom: 32 }} />
        <div
          aria-hidden="true"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 56,
            height: 56,
            marginBottom: 20,
            border: `1px solid ${connecting ? border.secondary : border.warning}`,
            borderRadius: radius.full,
            backgroundColor: connecting ? bg.subtle : bg.warning,
          }}>
          {connecting ? (
            <RefreshIcon size={24} color={icon.secondary} />
          ) : (
            <PowerIcon size={24} color={icon.warning} />
          )}
        </div>
        <div aria-live="assertive">
          <h1 style={{ ...heading['2xl'], margin: 0, color: text.default }}>
            {connecting ? 'Connecting to the Expo dev server' : 'Expo dev server disconnected'}
          </h1>
          <p
            style={{
              ...textSize.sm,
              maxWidth: 360,
              margin: '12px 0 0',
              color: text.secondary,
            }}>
            {connecting
              ? 'If this takes more than a few seconds, restart the Expo dev server in your terminal. Once it is running, reload this page.'
              : 'Restart the Expo dev server in your terminal. Once it is running again, reload this page.'}
          </p>
        </div>
        <Button
          theme="primary"
          size="lg"
          leftSlot={<RefreshIcon size={18} />}
          onClick={onReload}
          style={{ marginTop: 24 }}>
          Reload page
        </Button>
      </section>
    </main>
  );
}
