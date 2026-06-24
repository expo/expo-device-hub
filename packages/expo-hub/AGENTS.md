# Expo Hub — Style Guide

UI in `expo-hub` must look like the **Expo dashboard website** (`universe/server/website`).
Both share one design system: **`@expo/styleguide`**. This file is the contract for
producing matching UI here.

## TL;DR

- **Never hard-code colors, font sizes, radii, or shadows.** Use the tokens in
  [`theme/tokens.ts`](./theme/tokens.ts).
- Use the [`Button`](./components/Button.tsx) primitive instead of styling `<button>` by hand.
- Import [`theme/theme.css`](./theme/theme.css) once at the top of a DOM component so the
  CSS variables exist (already done in `HelloHub.tsx`).
- Light mode is the default. Dark mode = add the `dark-theme` class on a wrapper element.

## Source of truth & how Hub differs

| | Website (`universe/server/website`) | Expo Hub (this package) |
|---|---|---|
| Design system | `@expo/styleguide` | Same tokens, ported into `theme/` |
| Styling | Tailwind classes (`bg-default`, `heading-2xl`, …) via `@expo/styleguide/tailwind` preset | Inline styles via `theme/tokens.ts` |
| Components | `ui/components/*` (e.g. `ui/components/Button`) | Ported, dependency-free copies in `components/*` |
| Tokens CSS | `@expo/styleguide/dist/expo-theme.css` + `@radix-ui/colors` | Inlined into `theme/theme.css` |

Hub renders its UI as **Expo DOM components** (`'use dom'`) with **inline styles**, not
Tailwind. So we can't use the website's Tailwind classes directly — instead every Tailwind
token has a typed equivalent in `theme/tokens.ts`. The token doc-comments list the Tailwind
class each one maps to, so you can read website code and translate 1:1.

> When you port a component from the website, replace its Tailwind classes with the
> matching `tokens.ts` values rather than inventing new colors/sizes.

## The token files

- **`theme/theme.css`** — the design tokens as CSS custom properties. Inlines the
  [Radix Colors](https://www.radix-ui.com/colors) scales (slate, blue, green, amber, red,
  purple, light + dark) and the semantic `--expo-theme-*` layer, plus the base font/surface.
  This is a faithful copy of `@expo/styleguide/dist/expo-theme.css`. Import it once per
  DOM component subtree.
- **`theme/tokens.ts`** — typed JS bindings to those variables (`bg`, `text`, `icon`,
  `border`, `radius`, `shadow`, `font`, `textSize`, `heading`). Use these in inline styles.

## Colors — always semantic

Use the *role* token, never a raw hex or a raw Radix step. The semantic tokens flip
automatically between light and dark.

```tsx
import { bg, text, border } from './theme/tokens';

<div style={{ backgroundColor: bg.subtle, color: text.secondary,
              border: `1px solid ${border.default}` }} />
```

- **Backgrounds** (`bg.*`): `default`, `screen`, `subtle`, `element`, `hover`, `selected`,
  `overlay`, `success`, `warning`, `danger`, `info`, `preview`.
- **Text** (`text.*`): `default`, `secondary`, `tertiary`, `quaternary`, `link`,
  `success`, `warning`, `danger`, `info`, `preview`.
- **Icons** (`icon.*`) and **Borders** (`border.*`): same role names.

Background layering, light to dark surface: `default` → `screen` → `subtle` → `element`
→ `hover` → `selected`. Use `default` for cards/panels on a `screen` page background.

## Typography

Font families are set globally in `theme.css`: **Inter** for UI (`font.sans`),
**JetBrains Mono** for code (`font.mono`). Use the scales — don't pick arbitrary sizes.

```tsx
import { heading, textSize, text } from './theme/tokens';

<h1 style={{ ...heading['3xl'] }}>Title</h1>
<p style={{ ...textSize.base, color: text.secondary }}>Body copy</p>
```

- `heading['5xl' | '4xl' | '3xl' | '2xl' | 'xl' | 'lg' | 'base' | 'sm' | 'xs']` — weight 600,
  tight line-height. Matches website Tailwind `heading-*`. Website default `<h1>`=`heading-2xl`,
  `<h2>`=`heading-xl`, `<h3>`=`heading-lg`.
- `textSize['2xl' | 'xl' | 'lg' | 'base' | 'sm' | 'xs' | '2xs']` — body text. Matches `text-*`.
  Default body is `base` (16px).

Each entry carries `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing` — spread the whole
object so the type stays on the design grid.

## Radii & shadows

```tsx
import { radius, shadow } from './theme/tokens';
<div style={{ borderRadius: radius.xl, boxShadow: shadow.sm }} />
```

- `radius`: `xs` 2 · `sm` 4 · `md` 6 · `lg` 8 · `xl` 16 · `2xl` 20 · `3xl` 24 · `full`.
  Buttons use `lg`; cards/panels typically `xl`.
- `shadow`: `none`, `xs`, `sm`, `md`, `lg`, `xl` (theme-aware — heavier in dark mode).

## Buttons

Use [`components/Button.tsx`](./components/Button.tsx) — a dependency-free port of the
website's `ui/components/Button` (same `--expo-theme-button-*` tokens, hover/active/disabled
behavior).

```tsx
import { Button } from './components/Button';

<Button theme="primary" size="md" onClick={...}>Save</Button>
<Button theme="secondary" leftSlot={<Icon />}>With icon</Button>
<Button theme="primary-destructive" disabled>Delete</Button>
<Button theme="tertiary" href="/docs" target="_blank">Docs</Button>
```

- **themes**: `primary`, `secondary`, `tertiary`, `quaternary`, `primary-destructive`,
  `secondary-destructive`, `tertiary-destructive`. `primary` is black-on-white (white-on-black
  in dark mode); use it for the single main action per view.
- **sizes**: `2xs`, `xs`, `sm` (default), `md`, `lg`, `xl`, `2xl`.
- `block` stretches to full width; `leftSlot`/`rightSlot` for icons; `href` renders an `<a>`.

## Dark mode

Tokens are theme-aware. To render a subtree in dark mode, add `dark-theme` to a wrapper:

```tsx
<div className="dark-theme" style={{ backgroundColor: bg.default }}>…</div>
```

## Do / don't

- ✅ `color: text.secondary` — ❌ `color: '#60646c'`
- ✅ `...heading['2xl']` — ❌ `fontSize: 24, fontWeight: 600`
- ✅ `<Button theme="primary">` — ❌ a hand-styled `<button>`
- ✅ `backgroundColor: bg.success` for status surfaces — ❌ `'green'`
- ✅ add a new semantic need to `tokens.ts` (mirroring the website) — ❌ scatter literals

## Regenerating `theme/theme.css`

`theme.css` is a generated, faithful copy of the website's tokens. When `@expo/styleguide`
or `@radix-ui/colors` is upgraded in the website, regenerate by concatenating, in order:
the sRGB blocks of `@radix-ui/colors/{slate,blue,green,amber,red,purple}{,-dark}.css`, then
`@expo/styleguide/dist/expo-theme.css` with its leading `@import` lines removed, then the
base typography/surface block at the bottom of the current file. Do not hand-edit the color
scale values. If Hub later adds a Tailwind build, prefer depending on the published
`@expo/styleguide` (`@expo/styleguide/tailwind` preset + `dist/expo-theme.css`) directly
instead of this inlined copy.
