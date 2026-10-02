import { describe, expect, test } from 'bun:test';

import { startupMessage } from '../cli/startup';

describe('startupMessage', () => {
  test('keeps the loopback message as it was without a token', () => {
    expect(startupMessage({ host: '127.0.0.1', port: 3400 })).toBe(
      [
        'Expo Device Hub ready',
        '',
        '  Local:   http://localhost:3400',
        '  Network: pass --host 0.0.0.0 to expose on your local network',
      ].join('\n')
    );
  });

  // The operator is the only one told the token, so the links have to carry it.
  test('puts the token in every link under --require-token', () => {
    const message = startupMessage({
      host: '0.0.0.0',
      port: 3400,
      lanAddress: '192.168.1.20',
      sessionToken: 'tok-123',
    });

    expect(message).toContain('  Local:   http://localhost:3400/?token=tok-123');
    expect(message).toContain('  Network: http://192.168.1.20:3400/?token=tok-123');
    expect(message).toContain('The links above carry a token because anyone who has it can control');
  });

  test('puts the token in the local link on loopback too', () => {
    const message = startupMessage({ host: '127.0.0.1', port: 3400, sessionToken: 'tok-123' });

    expect(message).toContain('  Local:   http://localhost:3400/?token=tok-123');
    expect(message).not.toContain('listening on the network');
  });

  test('warns when the Hub listens on the network without a token', () => {
    const message = startupMessage({ host: '0.0.0.0', port: 3400, lanAddress: '192.168.1.20' });

    expect(message).toContain('  Network: http://192.168.1.20:3400');
    expect(message).toContain('with no token required');
    expect(message).toContain('Pass --require-token to gate it.');
  });

  // As in serve-sim, `--frame-ancestor` applies only under the token, so say that it did nothing.
  test('says that --frame-ancestor has no effect without --require-token', () => {
    const message = startupMessage({
      host: '127.0.0.1',
      port: 3400,
      ignoredFrameAncestors: ['https://*.expo.dev'],
    });

    expect(message.split('\n').at(-1)).toBe(
      '  --frame-ancestor has no effect without --require-token.'
    );
    expect(startupMessage({ host: '127.0.0.1', port: 3400, ignoredFrameAncestors: [] })).not.toContain(
      '--frame-ancestor'
    );
  });

  test('names a specific host in its network link', () => {
    const message = startupMessage({ host: '192.168.1.20', port: 3400, sessionToken: 'tok-123' });

    expect(message).not.toContain('Local:');
    expect(message).toContain('  Network: http://192.168.1.20:3400/?token=tok-123');
  });
});
