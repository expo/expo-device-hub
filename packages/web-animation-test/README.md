# Web animation test

A minimal Expo web app for comparing hardware and software H.264 encoding in
Expo Device Hub. It preserves the original fixture: a yellow shape rotating once
every two seconds over a striped background.

Open [the hosted animation](https://krystof-web-animation-test.expo.app) in the
device's browser, view the device through Expo Device Hub, and switch encoders to
compare the same animation. No local server is needed.

## Develop

After following the repository's dependency setup, run from this directory:

```sh
bun start
```

## Deploy

The app is linked to the personal
[`@krystofwoldrich/web-animation-test`](https://expo.dev/accounts/krystofwoldrich/projects/web-animation-test)
EAS project. Sign in with access to that project, then run from this directory:

```sh
bun run deploy
```

This exports the web app to `dist/` and deploys it to the stable testing URL above
using EAS Hosting's production alias. To export without deploying, run
`bun run build`. Generated files are ignored by Git.
