// Allow side-effect CSS imports (e.g. `import './theme/theme.css'`) in web /
// DOM components. Expo's Metro web bundler turns these into injected stylesheets.
declare module '*.css';

// Static image imports resolve to a URL (web) or asset object (native) via Metro.
declare module '*.png' {
  const src: string;
  export default src;
}
