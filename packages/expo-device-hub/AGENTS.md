# Expo Hub — Style Guide

UI in `expo-device-hub` must look like the **Expo dashboard website** (`universe/server/website`).
Both share one design system: **`@expo/styleguide`**. This file is the contract for
producing matching UI here.

> **Where the UI kit lives.** The ported components and design tokens are no longer in
> this package — they were extracted to **[`@expo/hub-components`](../@expo/hub-components)**
> (and the device-client hooks/types to **[`@expo/hub-client`](../@expo/hub-client)**) so the
> website can consume the same code. Import everything UI-related from `@expo/hub-components`.
> The Tailwind utility layer (`bg-default`, `animate-fadeIn`, …) those Radix components rely
> on still comes from the consumer — here that is [`global.css`](./global.css), which also
> `@source`s `@expo/hub-components/src` so Tailwind generates the utility classes those
> components use (Tailwind ignores `node_modules`, so without it the Dialog/Dropdown render
> unstyled and off-screen).

## TL;DR

- **Never hard-code colors, font sizes, radii, or shadows.** Use the tokens from
  [`@expo/hub-components`](../@expo/hub-components/src/theme/tokens.ts).
- Use the [`Button`](../@expo/hub-components/src/components/Button.tsx) primitive instead of
  styling `<button>` by hand.
- Import [`@expo/hub-components/theme.css`](../@expo/hub-components/src/theme/theme.css) once at
  the top of a DOM component so the CSS variables exist (already done in
  [`src/Dashboard.tsx`](./src/Dashboard.tsx)).
- Light mode is the default. Dark mode = add the `dark-theme` class on a wrapper element.

## Source of truth & how Hub differs

| | Website (`universe/server/website`) | Expo Hub (this package) |
|---|---|---|
| Design system | `@expo/styleguide` | Same tokens, ported into `@expo/hub-components` |
| Styling | Tailwind classes (`bg-default`, `heading-2xl`, …) via `@expo/styleguide/tailwind` preset | Inline styles via `@expo/hub-components` tokens |
| Components | `ui/components/*` (e.g. `ui/components/Button`) | Ported, dependency-free copies in `@expo/hub-components` |
| Tokens CSS | `@expo/styleguide/dist/expo-theme.css` + `@radix-ui/colors` | **Imported from `@expo/styleguide`** by `@expo/hub-components/theme.css` (only fonts/radii/reset are local) |

Hub renders its UI as **Expo DOM components** (`'use dom'`) with **inline styles**, not
Tailwind. So we can't use the website's Tailwind classes directly — instead every Tailwind
token has a typed equivalent exported by `@expo/hub-components`. The token doc-comments list the
Tailwind class each one maps to, so you can read website code and translate 1:1.

> When you port a component from the website, replace its Tailwind classes with the
> matching token values rather than inventing new colors/sizes.

## The token files

Both live in the [`@expo/hub-components`](../@expo/hub-components/src/theme) package:

- **`theme/theme.css`** — `@import`s `@expo/styleguide/dist/expo-theme.css` (the
  [Radix Colors](https://www.radix-ui.com/colors) scales + the semantic `--expo-theme-*` layer
  come straight from the styleguide, no longer inlined), then adds the few bits the styleguide's
  CSS lacks: the `--expo-font-*` families, the `--expo-radius-*` scale, and the base body/surface
  reset. Import it once per DOM component subtree via `import '@expo/hub-components/theme.css'`.
- **`theme/tokens.ts`** — typed JS bindings to those variables (`bg`, `text`, `icon`,
  `border`, `radius`, `shadow`, `font`, `textSize`, `heading`), re-exported from the package
  root. Use these in inline styles.

## Colors — always semantic

Use the *role* token, never a raw hex or a raw Radix step. The semantic tokens flip
automatically between light and dark.

```tsx
import { bg, text, border } from '@expo/hub-components';

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
import { heading, textSize, text } from '@expo/hub-components';

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
import { radius, shadow } from '@expo/hub-components';
<div style={{ borderRadius: radius.xl, boxShadow: shadow.sm }} />
```

- `radius`: `xs` 2 · `sm` 4 · `md` 6 · `lg` 8 · `xl` 16 · `2xl` 20 · `3xl` 24 · `full`.
  Buttons use `lg`; cards/panels typically `xl`.
- `shadow`: `none`, `xs`, `sm`, `md`, `lg`, `xl` (theme-aware — heavier in dark mode).

## Buttons

Use [`Button`](../@expo/hub-components/src/components/Button.tsx) — a dependency-free port of the
website's `ui/components/Button` (same `--expo-theme-button-*` tokens, hover/active/disabled
behavior).

```tsx
import { Button } from '@expo/hub-components';

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
- ✅ add a new semantic need to `@expo/hub-components` (mirroring the website) — ❌ scatter literals

## Updating the tokens CSS

`@expo/hub-components` depends on `@expo/styleguide`, and its `src/theme/theme.css` now
**`@import`s `@expo/styleguide/dist/expo-theme.css` directly** — the Radix scales + the
`--expo-theme-*` layer track the published styleguide automatically, so bump `@expo/styleguide`
to update them (no hand-regeneration). Only the local base block (`--expo-font-*`,
`--expo-radius-*`, the body/code reset) is hand-maintained here, since the styleguide's CSS
doesn't define those.

> The styleguide's **React components** (`Button`, `Link`, …) and its JS token objects are *not*
> importable in Hub: the package's component index pulls in `next/link` (`LinkBase`), which
> Metro can't bundle. That's why the primitives in `@expo/hub-components/src/components/*` stay
> dependency-free ports rather than re-exports of `@expo/styleguide`, and `theme/tokens.ts`
> keeps its own typed CSS-variable bindings.
