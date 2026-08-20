# Zustand UI state boundary

Status: implementation guidance based on the Zustand tutorial and examples, and on the current Expo Hub dashboard code.

## What the official material establishes

Zustand stores data and the actions that update it, and components subscribe with selectors. The store hook can contain primitives, objects, arrays, and functions; `set` shallow-merges updates, and no provider is required for a module-level store ([official introduction](https://zustand.docs.pmnd.rs/learn/getting-started/introduction)).

The supplied [tutorial](https://zustand.site/en/tutorial/) puts the todo collection and its add/toggle/remove actions in Zustand, but deliberately leaves the form's transient input text in React `useState`. The supplied [examples](https://zustand.site/en/examples/) also show that an entire form—values, errors, submission status, and async submit action—*can* live in a store. Therefore the docs do not imply that every `useState` must be replaced: state placement should follow ownership, lifetime, and sharing needs.

For TypeScript, use the curried `create<State>()(...)` form and colocate actions with their state ([TypeScript guide](https://zustand.docs.pmnd.rs/learn/guides/advanced-typescript), [Flux-inspired practice](https://zustand.docs.pmnd.rs/learn/guides/flux-inspired-practice)). Subscribe to the narrowest useful state with selectors; selecting the whole store rerenders on every change, while object/array selector results may need `useShallow` ([official README](https://github.com/pmndrs/zustand#fetching-everything), [`useShallow` guide](https://zustand.docs.pmnd.rs/learn/guides/prevent-rerenders-with-use-shallow)). Updates remain immutable, and nested objects must be copied explicitly because `set` merges only one level ([immutable state and merging](https://zustand.docs.pmnd.rs/learn/guides/immutable-state-and-merging)).

## Migration mechanics and caveats

- Replace each selected `useState` value with a typed store field and named action. When an existing setter accepts either a value or updater function, preserve that behavior explicitly with functional `set`; Zustand supports both partial objects and updater functions ([updating state](https://zustand.docs.pmnd.rs/learn/guides/updating-state)).
- Replace `useReducer` dispatches with named actions that call `set` when those actions communicate domain intent. If the reducer/dispatch contract remains useful, Zustand also documents wrapping the existing reducer in a root `dispatch` action or using its Redux middleware ([Flux-inspired practice](https://zustand.docs.pmnd.rs/learn/guides/flux-inspired-practice)).
- Keep lifecycle work in React effects: effects may open subscriptions or start async actions and must still clean up sockets, observers, timers, and listeners. Zustand changes state ownership, not component lifecycle.
- A store created at module scope is shared. State that must be isolated per component/subtree or initialized from props needs a scoped vanilla `createStore` plus `useStore`/Context ([initialize state with props](https://zustand.docs.pmnd.rs/learn/guides/initialize-state-with-props), [`useStore` reference](https://zustand.docs.pmnd.rs/reference/hooks/use-store)). That extra machinery is a reason not to globalize instance-local hover, focus, measurement, or animation state.
- Do not use `set(nextState, true)` casually: replacement can erase colocated actions; normal `set` performs the intended shallow merge ([official README](https://github.com/pmndrs/zustand#overwriting-state)).

## Recommended Expo Hub scope

The first implementation should use one typed dashboard store, optionally divided into slices if it grows ([slices pattern](https://zustand.docs.pmnd.rs/learn/guides/slices-pattern)).

| State | Recommendation | Reason |
| --- | --- | --- |
| Selected device, optimistic `added` devices, stream mode | Put in the dashboard store | These fields coordinate several parts of [`Dashboard.tsx`](../src/Dashboard.tsx) and represent durable dashboard intent. Put mutations such as select/add/shutdown/remove and stream-mode validation behind store actions. |
| Sidebar widths, left/right preference, and last-opened side | Put in a layout slice | They jointly determine the two sidebar render modes in [`useSidebarLayout.ts`](../src/dashboard/useSidebarLayout.ts). Centralizing the source values makes derived layout a selector/pure function rather than duplicated state. |
| Hide-unsupported preference | Put in a preference slice, if it is in the requested scope | It is user-visible, cross-component, persistent UI preference. Preserve the existing cross-tab storage behavior in [`deviceVisibility.ts`](../src/dashboard/deviceVisibility.ts); Zustand persistence is optional, not required. |
| Add-device modal open state and form workflow (`target`, runtime, model, name, submitting, error) | Include only if modal state is meant to be shared across docked/overlay render modes | The official examples validate this pattern, but it changes the form from instance-owned to dashboard-owned. Add an explicit reset-on-open/close action so a module-level store does not retain stale form state; Zustand documents resetting via initial state ([reset guide](https://zustand.docs.pmnd.rs/learn/guides/how-to-reset-state)). |
| WebSocket device snapshots and fetched creation options | Keep in source-adapter hooks by default | [`useDevices.ts`](../src/dashboard/useDevices.ts) and [`useNewDeviceOptions.ts`](../src/dashboard/useNewDeviceOptions.ts) represent server state, not local UI intent. Zustand supports async actions ([tutorial](https://zustand.site/en/tutorial/)), so they can be migrated if the requirement is literally “no `useState` in the dashboard,” but doing so broadens the change into connection/cache ownership. |
| Color scheme, reduced-motion, container measurements, animation-presence flags | Keep lifecycle-local by default | These mirror browser/DOM state and are coupled to effects, observers, animation cleanup, or a particular mounted element. A singleton store would need explicit instance identity and cleanup without improving sharing. |
| Primitive hover/pressed/focused/dragging state and measured pill layout in `@expo/hub-components` | Keep component-local | These values belong to one primitive instance. Moving them into a global store risks coupling separate buttons, switches, handles, or modals and would make the shared component package depend on app-level state. The tutorial's local input demonstrates that keeping transient state in React is an intended boundary. |
| Connection/media state and the AVCC fallback reducer in `@expo/hub-client` | Keep in the client package | These model a reusable device-client lifecycle rather than dashboard UI intent. Migrating them is a separate state-machine/API redesign, not a local dashboard-state change. |

Values computed from store inputs should stay derived instead of being duplicated in the store: selected device lookup, merged/filtered device lists, sidebar docking/overlay flags, and form validity all fit selector or pure-function derivation ([tutorial computed-value example](https://zustand.site/en/tutorial/), [TypeScript derived-state guidance](https://zustand.docs.pmnd.rs/learn/guides/beginner-typescript#derived-state-with-selectors)). React effects, refs, and memos are still appropriate for subscriptions, DOM handles, and expensive derivations; adopting Zustand only replaces the chosen state ownership.

## Scope decision required before implementation

This is also a package-boundary decision, not only a state-kind decision. A current-tree text scan finds React state/reducer declarations across 70 files: 16 in `expo-device-hub`, 29 in `@expo/hub-client`, 27 in `@expo/hub-components`, 41 in the vendored `serve-emu`, 127 in the vendored `serve-sim`, and 1 in `example` (241 declarations total).

Confirm whether “instead of the used state hooks from React” means:

1. **Recommended:** migrate shared/dashboard-owned UI intent only, leaving instance-local interaction, DOM/environment snapshots, animation state, server/client adapters, and reusable package internals in React; or
2. **Literal app boundary:** remove every `useState`/`useReducer` reachable from Expo Hub, including `@expo/hub-components` primitives and `@expo/hub-client` connection/media state; or
3. **Literal monorepo boundary:** also migrate the independently packaged/vendored `serve-sim`, `serve-emu`, and the example app.

The literal interpretations are much larger, add global identity/reset concerns, and cross package API boundaries. They should not be inferred from the Zustand tutorial or examples.
