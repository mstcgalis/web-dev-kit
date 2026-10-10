# Stack templates: `nix flake init -t web-dev-kit#<stack>`

Roadmap module 2 (stack adapters), first slice. A new project starts from a working flake,
justfile and `wdk.config.js` instead of hand-copying them.

## Goal and success

`nix flake init -t web-dev-kit#<stack>` yields a project whose `wdk smoke` and `wdk a11y` pass on
day one. Stacks: `static`, `kirby`, `eleventy` (first build stack; modelled on dgalis.sk,
`~/src/personal-website`, which is not touched).

## Design

- `flake.nix` gains `templates.{static,kirby,eleventy}`, each `path = ./templates/<name>`.
- Each `templates/<name>/` holds: `flake.nix` (wdk input, `lib.devShell { stack = … }`),
  `justfile`, `wdk.config.js`, `.gitignore`, and a minimal page so checks pass.
- Recipes, per the contract's required set:
  - `static`: no build; `serve-at PORT` = `wdk serve-dir site {{PORT}}`.
  - `kirby`: `build` is a no-op; `serve-at PORT` = `php -S` with the router.
  - `eleventy`: `build` = `bunx eleventy` into `_site`; `serve-at PORT` = `wdk serve-dir _site {{PORT}}`;
    `check` builds first. Devshell packages equal `static`'s: Eleventy comes from the project's
    bun dependencies. Pass `stack = "eleventy"` anyway so a later stack-specific tool has a home;
    add `eleventy = [ ]` to the `stacks` set in `flake.nix`.
- Not built: `AGENTS.md` (roadmap §0 shared rules still open), Astro/Vite (same pattern later),
  a `stack` field in `wdk.config.js`.

## Test

`test/templates.test.js`: copy each template to a temp dir, run `wdk smoke` and `wdk a11y` against
it. Kirby is skipped when `php` is not on `PATH`. Eleventy needs `bun install` first, so the test
installs the template's dependencies.

## Docs

README gets a "New project" section; the roadmap's templates item is marked done.
