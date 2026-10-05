# web-kit: repo contract + checks module — design

Date: 2026-10-05 · Status: draft for review · Seed: `sonda-web/perf/`, this repo's `a11y`

## Context

The end goal is a modular, stack-agnostic, script-driven system that takes a website from first
prompt to deployed (repo, stack, domain, VPS, CI) in minutes. It is built from scripts, not around
any one agent. It decomposes into:

| # | Module | Where | Spec |
|---|---|---|---|
| 0 | Repo contract | this repo | **this spec (thin)** |
| 1 | Checks: a11y, compat, smoke, shots, perf | this repo | **this spec** |
| 2 | Stack adapters (devShell + `just` recipes per stack) | this repo | this spec covers `kirby` and `static` only |
| 3 | Deploy: one parametrised `site.nix`, project flakes as inputs | `~/src/vps` | later |
| 4 | CI/CD reusable workflows | this repo | later (this spec only moves sonda's test job to Nix) |
| 5 | Bootstrap CLI (`nix flake init -t` + repo/DNS/vps wiring) | this repo | last |

This repo (`web-checks`) is renamed **`web-kit`**. GitHub redirects the old URL, so sonda's
current `#v0.1.0` pin keeps resolving until it migrates.

## Decisions (from brainstorming)

- **Delivery:** the kit is a **Nix flake input**, pinned by `flake.lock`. Pinned packages over
  scaffolding: fixes propagate on purpose by bumping the input.
- **One kit repo, one tag**, so modules never skew against each other. Infra stays in `vps`.
- **The interface is `just` recipe names.** Modules only call `just <recipe>` or read
  `kit.config.js`; they never know the stack.
- **Bun is the kit's implementation language**, not a project requirement.
- **Gating:** `a11y`, `compat` and `smoke` can fail `just check` and CI. `shots` and `perf` are
  local tools.
- **Browsers:** on the Mac, perf and shots use native browsers (branded Chrome on Metal, real
  Firefox, pinned FF115), because they are the thing being measured. CI on Linux uses nixpkgs
  browsers.
- **FF115 layout matters** (it already broke once on sonda), so old binaries get screenshots.

## 0. Repo contract

Every project:

```
flake.nix         inputs.kit.url = "github:mstcgalis/web-kit/<tag>";
                  devShells.default = kit.lib.devShell { inherit pkgs; stack = "kirby"; };
justfile          stack recipes + project recipes; `check` calls `kit` commands
kit.config.js     the only kit configuration file (shape below)
.kit/             gitignored; shot sheets and perf results
```

**Required `just` recipes** (the stack adapter's job; the project writes them, or copies them from
the stack template):

| Recipe | Contract |
|---|---|
| `install` | fetch dependencies (`composer install`, nothing, …) |
| `build` | produce the deployable output; no-op for no-build stacks |
| `serve` | dev server for humans |
| `serve-at PORT` | server for checks on PORT, foreground, killable by process group |

`check` is the project's gate and calls whichever `kit` commands it wants.

**`kit.lib.devShell { pkgs, stack }`** provides `just`, `bun`, `kit`, plus the stack's tools:
- `kirby`: `php` 8.5 (same attribute as the vps FPM pool) and `composer`.
- `static`: nothing extra.

On Linux it also sets `PLAYWRIGHT_BROWSERS_PATH` to nixpkgs `playwright-driver.browsers`.

**`kit serve-dir DIR PORT`** is the static stack's `serve-at`. It is the current `serveDir`,
promoted to a subcommand.

### `kit.config.js`

```js
export default {
	pages: { start: ['/', '/cs', '/does-not-exist'], skip: '^/(media|assets|panel|api)\\b', limit: 80 },
	engines: {
		ci: ['chromium', 'firefox', 'webkit'],
		local: ['chrome', 'firefox', 'webkit', 'exe:firefox:/tmp/ff115/Firefox.app/Contents/MacOS/firefox'],
	},
	viewports: [[390, 844], [1440, 900]],
	compat: { css: ['assets/css/*.css'], targets: 'defaults, Firefox ESR, Firefox >= 115, Safari >= 17', allow: [] },
	proxy: { block: ['panel', 'api', '*.php'] }, // read-only guard for --serve on the LAN
	perf: { page: '/', knobs: { /* sonda's perf/knobs.js KNOBS, verbatim */ } },
};
```

Every key is optional. Defaults are the current `a11y` defaults. `engines.ci` is used when the
`CI` environment variable is set, and `engines.local` otherwise. `--engines` overrides both.

## 1. Checks module

### Internals (`lib/`, one job each)

| File | Job | Source |
|---|---|---|
| `site.js` | start `just serve-at {port}` on a free port, wait for it, stop the process group; crawl from `pages` | `a11y` today |
| `config.js` | load `kit.config.js` from cwd, apply defaults | new |
| `engines.js` | `playwright:<name>` and `exe:<kind>:<path>` engines. Keeps the Metal flags, profile-path process discovery, kill by profile, Rosetta refusal, one page per measurement and frontmost forcing | `perf/run.js` |
| `proxy.js` | rewriting proxy: applies knobs, injects the **error beacon**, rewrites origin, enforces the read-only `proxy.block` guard, strips method-override headers | `perf/run.js` + `knobs.js` |
| `cpu.js` | `ps` process-tree sampler; macOS only, fails loudly elsewhere | `perf/run.js` |

**Error beacon:** a small inline script injected first in `<head>`. It forwards `error`,
`unhandledrejection` and `console.error` to `POST /__kit/beacon` on the proxy, which records them
per page. This is how browsers Playwright cannot drive (FF115, a real old phone on the LAN) report
runtime errors.

### Commands

| Command | Behaviour | Exit |
|---|---|---|
| `kit a11y` | unchanged, except pages come from config and the server from `serve-at` | 1 on any violation |
| `kit compat` | doiuse over the `compat.css` globs against `compat.targets`, minus `compat.allow` feature ids. Prints file:line, feature and failing browsers | 1 on any finding |
| `kit smoke` | crawl × engines. Playwright engines fail on `pageerror`, `console.error`, same-origin `requestfailed`, any same-origin subresource ≥ 400, and a document ≥ 500 (a document 404 is fine: `/does-not-exist` is a start path on purpose). `exe:` engines visit the page list crawled by the first Playwright engine, through the proxy, wait 3s and read the beacon | 1 on any error |
| `kit shots` | crawl × engines × viewports, through the proxy with the `motion` knob (or `animations: 'disabled'` in Playwright). Playwright uses full-page `page.screenshot`. `exe:firefox` runs `firefox --headless --no-remote --profile <tmp> --window-size=W,H --screenshot out.png URL`; `exe:chrome` runs `--headless --window-size=W,H --screenshot=out.png URL`. Output is `.kit/shots/<date>-<sha>/index.html`: rows are pages, columns are engine × viewport, plus a list of beacon errors seen | 0 (report only) |
| `kit perf` | today's `run.js` behaviour: knob variants × engines × idle/mouse, median and range, `--save-baseline`, `--serve` for the LAN. Results go to `.kit/perf/`, the baseline to `perf-baseline.json` (committed) | 0 (report only) |

### Not built (add when needed)

- Static JS compat audit: `smoke` in old engines covers real breakage.
- Pixel diffing against a baseline: the contact sheet is reviewed by eye.
- Screenshots of browsers with no headless screenshot flag (old Safari): out of reach on this
  machine; use `kit perf --serve` on a real device.

## Packaging

- `flake.nix` exports `packages.kit` (the bun program plus its pinned `node_modules`), `lib.devShell`,
  and `checks` (runs `bun test` on Linux).
- `templates.kirby` and `templates.static` are deferred to the CLI spec.
- `exe:` FF115 is pinned through the flake as a fixed-output derivation of the ESR tarball (Linux)
  or `.dmg` (macOS). This replaces the manual `/tmp/ff115` + `policies.json` + `chmod` steps.

**Verify first.** Each of these is a spike in the plan; the design changes if one fails.

1. Bun deps into a Nix derivation: `bun2nix` vs a fixed-output `node_modules` hash.
2. **The Playwright npm version must equal nixpkgs' `playwright-driver` version**, or the Linux
   browsers will not launch. Pin the npm version to whatever the kit's nixpkgs ships.
3. Whether FF115 `--screenshot` captures the full page. If not, set the window height to the page
   height measured in the Playwright Firefox run.
4. Whether the FF115 macOS `.dmg` unpacks in a fixed-output derivation (`undmg`) and runs from the
   store without a writable app bundle.

## Testing

- `test/site/` (static) gains `broken-js.html` (throws on load), `new-css.html` (a feature outside
  the test targets), and a knob target.
- `bun test` drives each command against it through `kit serve-dir`.
- Assertions:
  - a11y and smoke exit 1 on the bad pages and 0 on the rest;
  - compat reports exactly the planted feature;
  - shots writes a sheet with the expected rows and columns;
  - the proxy blocks `/panel`, `/%70anel` and `/index.php/panel`, and strips `X-HTTP-Method-Override`.
- Perf: a unit test of `rewriteHtml` and knob parsing only (the CPU sampler is not CI-testable).
- Kit CI runs `nix flake check` on `ubuntu-latest`.

## Sonda migration (last step, in sonda-web)

1. Add `flake.nix` using `kit.lib.devShell { stack = "kirby"; }`.
2. Write `kit.config.js`, with `perf.knobs` taken from `perf/knobs.js` verbatim.
3. Add `serve-at PORT: php -S localhost:{{PORT}} tests/a11y/router.php`.
4. `check` gains `kit compat` and `kit smoke`.
5. Delete `perf/`, the `web-checks` devDependency and the `a11y` package.json script.
6. Update `docs/perf.md` with the new commands. The findings tables and measurement traps stay.
7. `tests.yml` runs `nix develop -c just check`.

Deploys are untouched: the store-path deploy is the vps spec, and dgalis.sk goes first.
