#!/usr/bin/env node
'use strict';

// Expo CLI invokes this as:
//   node ./cli/index.js <command> <argsJson> <metroServerOrigin>
const [, , command, argsJson, metroServerOrigin] = process.argv;

let args = {};
try {
  args = JSON.parse(argsJson || '{}');
} catch {
  // ignore malformed args, fall back to {}
}

// Output protocol: print either plain text lines, or a JSON array of
// `{ type: 'text', text, level?: 'info' | 'warning' | 'error', url? }`.
function emit(lines) {
  process.stdout.write(JSON.stringify(lines));
}

switch (command) {
  case 'greet': {
    emit([
      { type: 'text', text: `Hello, ${args.name ?? 'device'}!`, level: 'info' },
      { type: 'text', text: `Metro dev server: ${metroServerOrigin}`, level: 'info' },
    ]);
    break;
  }
  default: {
    emit([{ type: 'text', text: `Unknown command: ${command}`, level: 'error' }]);
    process.exit(1);
  }
}
