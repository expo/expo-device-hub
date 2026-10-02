import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { unauthorizedPage } from '../unauthorized-page';

// The token form loads before the gate passes, so it cannot load the dashboard's stylesheet. It
// copies the theme variables it uses instead. These tests keep each copy equal to the value the
// dashboard reads from `@expo/hub-components/theme.css` and the sheets that file imports.

type Rule = { prelude: string; body: string };
type Variables = Map<string, string>;

function topLevelRules(css: string): Rule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '{' && depth++ === 0) {
      bodyStart = i + 1;
    } else if (char === '}' && --depth === 0) {
      rules.push({ prelude: source.slice(preludeStart, bodyStart - 1).trim(), body: source.slice(bodyStart, i) });
      preludeStart = i + 1;
    } else if (char === ';' && depth === 0) {
      preludeStart = i + 1;
    }
  }
  return rules;
}

/** The custom properties that top-level rules for `selector` set. At-rule blocks are skipped. */
function variablesFor(css: string, selector: string): Variables {
  const found: Variables = new Map();
  for (const rule of topLevelRules(css)) {
    if (!rule.prelude.split(',').some((part) => part.trim() === selector)) continue;
    for (const [, name, value] of rule.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      found.set(name!, value!.trim());
    }
  }
  return found;
}

/** A stylesheet, preceded by the sheets it imports, in cascade order. */
function withImports(path: string): string[] {
  const css = readFileSync(path, 'utf8');
  const resolveFrom = createRequire(path);
  return [
    ...[...css.matchAll(/@import\s+['"]([^'"]+)['"]/g)].flatMap(([, spec]) =>
      withImports(resolveFrom.resolve(spec!))
    ),
    css,
  ];
}

function merged(scopes: Variables[]): Variables {
  return new Map(scopes.flatMap((scope) => [...scope]));
}

function resolved(value: string, scope: Variables, seen: ReadonlySet<string> = new Set()): string {
  return value.replace(/var\((--[\w-]+)\)/g, (reference, name: string) => {
    const next = scope.get(name);
    return next === undefined || seen.has(name) ? reference : resolved(next, scope, new Set(seen).add(name));
  });
}

const normalized = (value: string) => value.toLowerCase().replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ').trim();

const dashboardSheets = withImports(createRequire(import.meta.url).resolve('@expo/hub-components/theme.css'));
const dashboardLight = merged(dashboardSheets.map((css) => variablesFor(css, ':root')));
const dashboardDark = merged([dashboardLight, ...dashboardSheets.map((css) => variablesFor(css, '.dark-theme'))]);

const page = unauthorizedPage({ rejectedToken: true });
const pageCss = page.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
const darkMedia = topLevelRules(pageCss).find(
  (rule) => rule.prelude.replace(/\s+/g, '') === '@media(prefers-color-scheme:dark)'
);
const pageLight = variablesFor(pageCss, ':root');
const pageDark = merged([pageLight, variablesFor(darkMedia?.body ?? '', ':root')]);

describe('the token form theme', () => {
  // The dashboard follows the system setting too (`useColorScheme`).
  test('is light by default and dark when the system prefers dark', () => {
    expect(variablesFor(pageCss, ':root').size).toBeGreaterThan(0);
    expect(topLevelRules(pageCss).find((rule) => rule.prelude === ':root')?.body).toContain(
      'color-scheme:light'
    );
    expect(darkMedia?.body).toContain('color-scheme:dark');
  });

  test.each([
    ['light', pageLight, dashboardLight],
    ['dark', pageDark, dashboardDark],
  ] as const)('copies the dashboard %s values', (_scheme, copies, dashboard) => {
    for (const [name, value] of copies) {
      expect({ [name]: normalized(resolved(value, copies)) }).toEqual({
        [name]: normalized(resolved(`var(${name})`, dashboard)),
      });
    }
  });

  // Anything else would be a color the dashboard does not use.
  test('colors the page only through those variables', () => {
    const withoutCopies = page.replace(/--[\w-]+\s*:[^;]+;/g, '');

    expect(withoutCopies.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|color)\(/gi)).toBeNull();
  });
});
