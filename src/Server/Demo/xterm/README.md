# Browser terminal assets

The Demo embeds the following MIT-licensed distributions from npm.

- `@xterm/xterm@6.0.0` provides `lib/xterm.mjs` and `css/xterm.css`.
- `@xterm/addon-fit@0.11.0` provides `lib/addon-fit.mjs`.

The modules omit source map references. In `xterm.mjs`, the three generated stylesheet elements use `createFileSharingTerminalStyle` so the Demo can apply its per-page CSP nonce. The other assets match the published distributions.
