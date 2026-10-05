# web-kit

Shared tooling for web projects, delivered as a Nix flake: the `kit` command (checks) and dev
shells per stack. Part of a larger system for delivering sites; see [`docs/roadmap.md`](docs/roadmap.md).

## Use in a project

```nix
# flake.nix
{
  inputs.kit.url = "github:mstcgalis/web-kit/v0.2.0";
  inputs.nixpkgs.follows = "kit/nixpkgs";
  outputs = { kit, nixpkgs, ... }: {
    devShells = nixpkgs.lib.genAttrs [ "aarch64-darwin" "x86_64-linux" ] (system: {
      default = kit.lib.devShell { pkgs = nixpkgs.legacyPackages.${system}; stack = "kirby"; }; # or "static"
    });
  };
}
```

The project's `justfile` must have **`serve-at PORT`**: a foreground server on PORT. Every command
starts the site through it. Static sites use `kit serve-dir DIR {{PORT}}`.

On macOS, run `kit install-browsers` once. On Linux the dev shell provides the browsers.

## Commands

| | | Exit |
|---|---|---|
| `kit a11y` | axe-core, WCAG 2.2 AA + best practice, every crawled page | 1 on violations |
| `kit compat` | `compat.css` against `compat.targets` (browserslist), via doiuse | 1 on findings, 2 if globs match nothing |
| `kit smoke` | every page × engine; runtime errors, `console.error`, broken same-origin requests | 1 on errors |
| `kit shots` | contact sheet at `.kit/shots/…/index.html`: pages × engine × viewport | 0 |
| `kit perf` | CPU per perf knob, idle and mouse; macOS only (see traps below) | 0 |

`--engines a,b` overrides the config for `smoke`, `shots` and `perf`; `--skip REGEX` for the crawl.

## `kit.config.js`

```js
export default {
  pages: { start: ['/', '/does-not-exist'], skip: '^/(media|panel)\\b', limit: 80 },
  engines: { ci: ['chromium', 'firefox', 'webkit'], local: ['chrome', 'firefox', 'webkit', 'exe:firefox:$KIT_FIREFOX_115'] },
  viewports: [[390, 844], [1440, 900]],
  compat: { css: ['assets/css/*.css'], targets: 'defaults, Firefox >= 115', allow: [] },
  proxy: { block: ['panel', 'api', '*.php'] },
  perf: { page: '/', knobs: { zoom: { css: '…', probe: '.slide img' }, seismo: { script: 'seismograph' } } },
};
```

Engines: `chrome` (branded), `chromium`, `firefox`, `webkit`, or `exe:<firefox|chrome>:<path>` for a
binary Playwright cannot drive. The path may be `$VAR`.

Every browser goes through a proxy that injects an error beacon, which is how `exe:` engines report
errors. The proxy also takes `?kit-off=a,b|static`, `?kit-mouse` and `?kit-freeze`, so
`kit perf --serve` variants open on any device on the LAN.

## Measurement traps (perf)

Each of these produced confident, wrong numbers once:
1. Rosetta: an x86 parent launches browsers translated. `kit perf` refuses to run.
2. Chrome on SwiftShader instead of Metal: fixed by `CHROME_ARGS`.
3. Counting one process: count the whole tree, including GPU and XPC helpers.
4. Background tabs keep animating: one page per measurement.
5. Occluded windows aren't composited: the window is forced frontmost before sampling.
6. Firefox ESR updates itself: use the flake's pinned FF115 (`$KIT_FIREFOX_115`).
7. One run proves nothing: the median and range of `--repeat` runs.

## Develop

`nix develop`, then `bun install`, then `just check`. After changing `bun.lock`, run `just hash` and
update `outputHash` in `flake.nix`.

## Licence

AGPL-3.0.
