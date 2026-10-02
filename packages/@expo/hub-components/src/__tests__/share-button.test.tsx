import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { copyTextToClipboard, ShareButton, ShareLinkPanel } from '../dashboard/ShareButton';

const URL = 'http://192.168.1.20:3400/?token=tok-1';

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const realDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => {
  for (const [name, descriptor] of [
    ['navigator', realNavigator],
    ['document', realDocument],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function stub(name: 'navigator' | 'document', value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/** A document whose legacy copy succeeds or fails, recording what it copied. */
function legacyDocument(succeeds: boolean) {
  const copied: string[] = [];
  let value = '';
  stub('document', {
    body: { appendChild() {} },
    createElement: () => ({
      set value(next: string) {
        value = next;
      },
      style: {},
      setAttribute() {},
      select() {},
      setSelectionRange() {},
      remove() {},
    }),
    execCommand: (command: string) => {
      if (command === 'copy' && succeeds) copied.push(value);
      return succeeds;
    },
  });
  return copied;
}

describe('copyTextToClipboard', () => {
  test('uses the async clipboard where the page may', async () => {
    const written: string[] = [];
    stub('navigator', { clipboard: { writeText: async (text: string) => void written.push(text) } });

    expect(await copyTextToClipboard(URL)).toBe(true);
    expect(written).toEqual([URL]);
  });

  // A LAN Hub over plain http is not a secure context, so it has no navigator.clipboard.
  test('falls back to the selection copy outside a secure context', async () => {
    stub('navigator', {});
    const copied = legacyDocument(true);

    expect(await copyTextToClipboard(URL)).toBe(true);
    expect(copied).toEqual([URL]);
  });

  test('falls back when the async clipboard refuses, and reports a failed copy', async () => {
    stub('navigator', { clipboard: { writeText: async () => Promise.reject(new Error('denied')) } });
    legacyDocument(false);

    expect(await copyTextToClipboard(URL)).toBe(false);
  });
});

describe('ShareButton', () => {
  test('says in its tooltip when the link includes the access token', () => {
    const gated = renderToStaticMarkup(<ShareButton icon={null} url={URL} carriesToken />);
    const open = renderToStaticMarkup(<ShareButton icon={null} url="http://localhost:3400/" carriesToken={false} />);

    expect(gated).toContain('aria-label="Share"');
    expect(gated).toContain('Copy share link (includes access token)');
    expect(open).toContain('Copy share link');
    expect(open).not.toContain('access token');
  });
});

describe('ShareLinkPanel', () => {
  test('offers the link for a manual copy and warns about the token', () => {
    const markup = renderToStaticMarkup(<ShareLinkPanel url={URL} carriesToken onDone={() => {}} />);

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain(`value="${URL}"`);
    expect(markup).toContain('readOnly=""');
    expect(markup).toContain('Anyone who has it can control the devices');
  });

  test('says who can open a link without a token', () => {
    const markup = renderToStaticMarkup(
      <ShareLinkPanel url="http://localhost:3400/" carriesToken={false} onDone={() => {}} />
    );

    expect(markup).toContain('Anyone who can reach this address can open it.');
  });
});
