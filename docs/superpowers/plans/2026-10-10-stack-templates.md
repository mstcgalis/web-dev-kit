# Stack templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `nix flake init -t web-dev-kit#<static|kirby|eleventy>` yields a project that passes wdk checks.

**Architecture:** `templates/<name>/` dirs, exposed through a `templates` output in `flake.nix`. One bun test copies each template to a temp dir and runs `wdk` against it, with a `wdk` shim on `PATH` so the template's `serve-at` recipe works outside a Nix shell.

**Tech Stack:** Nix flakes, bun test, just, Eleventy 3.

**Spec:** `docs/superpowers/specs/2026-10-10-stack-templates-design.md`

## Global Constraints

- bun only (never npm/npx). Tabs in JS, matching `lib/`. Conventional commits, no Claude sign-off beyond the system-reminder trailer.
- `flake.nix` `stacks` set gains `eleventy = [ ]`.
- Spec deviation: Kirby is not smoke-tested (it needs a Kirby checkout + PHP). Its test only checks the files exist and `just --list` parses the justfile.

## Review Focus

- A template run from a directory that already has files: `nix flake init` refuses to overwrite; nothing for us to do, but no template file may be a dotfile-only surprise (`.gitignore` must ship as `.gitignore`, not be dropped by the flake source filter).
- Eleventy `_site` stale from a previous build: `build` must not leave `check` testing old output (`rm -rf _site` first).
- `serve-at` called with a port in use: inherited from `wdk serve-dir`, covered by existing tests.

---

### Task 1: static + eleventy templates, flake output, test

**Files:**
- Create: `templates/static/{flake.nix,justfile,wdk.config.js,.gitignore,site/index.html}`
- Create: `templates/eleventy/{flake.nix,justfile,wdk.config.js,.gitignore,package.json,eleventy.config.js,src/index.html}`
- Modify: `flake.nix` (add `templates` output, `eleventy = [ ]`)
- Test: `test/templates.test.js`

**Interfaces:** Produces `templates.{static,eleventy,kirby}` flake outputs; Task 2 adds `kirby`.

- [ ] **Step 1: Write the failing test** — `test/templates.test.js`

```js
import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const sh = (cmd, args, cwd, env = {}) => {
	const r = Bun.spawnSync([cmd, ...args], { cwd, env: { ...process.env, ...env } });
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

// A `wdk` on PATH, as the dev shell provides, so the template's serve-at recipe resolves.
const bin = mkdtempSync(join(tmpdir(), 'wdk-bin-'));
writeFileSync(join(bin, 'wdk'), `#!/bin/sh\nexec bun ${ROOT}/bin/wdk.js "$@"\n`);
chmodSync(join(bin, 'wdk'), 0o755);
const env = { PATH: `${bin}:${process.env.PATH}` };

function project(name) {
	const dir = mkdtempSync(join(tmpdir(), `wdk-tpl-${name}-`));
	cpSync(join(ROOT, 'templates', name), dir, { recursive: true });
	return dir;
}

for (const name of ['static', 'eleventy']) {
	test(`template ${name}: smoke and a11y pass`, () => {
		const dir = project(name);
		if (name === 'eleventy') {
			expect(sh('bun', ['install'], dir).code).toBe(0);
			expect(sh('just', ['build'], dir, env).code).toBe(0);
		}
		const smoke = sh('wdk', ['smoke', '--engines', 'chromium'], dir, env);
		expect(smoke.out).toContain('0 error(s)');
		expect(smoke.code).toBe(0);
		expect(sh('wdk', ['a11y'], dir, env).code).toBe(0);
	}, 180_000);
}
```

(Shim is invoked as `wdk` via `Bun.spawnSync(['wdk', …])`; if bun can't resolve it through the `env` PATH, spawn `join(bin, 'wdk')` instead.)

- [ ] **Step 2: Run it** — `bun test test/templates.test.js` → FAIL (`templates/` missing).

- [ ] **Step 3: Create the static template**

`templates/static/flake.nix`:
```nix
{
  inputs.wdk.url = "github:mstcgalis/web-dev-kit";
  inputs.nixpkgs.follows = "wdk/nixpkgs";
  outputs = { wdk, nixpkgs, ... }: {
    devShells = nixpkgs.lib.genAttrs [ "aarch64-darwin" "x86_64-linux" ] (system: {
      default = wdk.lib.devShell { pkgs = nixpkgs.legacyPackages.${system}; stack = "static"; };
    });
  };
}
```
`templates/static/justfile`:
```just
default:
    @just --list

# required by wdk: a foreground server on PORT
serve-at PORT:
    wdk serve-dir site {{PORT}}

# no build step
build:

check:
    wdk compat
    wdk smoke
    wdk a11y
```
`templates/static/wdk.config.js`:
```js
export default {
	pages: { start: ['/'] },
	engines: { ci: ['chromium', 'firefox', 'webkit'], local: ['chrome', 'firefox', 'webkit'] },
	viewports: [[390, 844], [1440, 900]],
	compat: { css: ['site/*.css'], targets: 'defaults', allow: [] },
};
```
`templates/static/.gitignore`: `node_modules/`, `.wdk/`, `result` (one per line).
`templates/static/site/index.html`:
```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>New site</title></head>
<body><main><h1>New site</h1></main></body>
</html>
```
(`compat.css` globs match nothing → exit 2; so also add `templates/static/site/style.css` containing `body{font-family:system-ui}` and link it from the page with `<link rel="stylesheet" href="/style.css">`.)

- [ ] **Step 4: Create the eleventy template.** Same `flake.nix` with `stack = "eleventy"`, same `.gitignore` plus `_site/`, same `wdk.config.js` but `compat.css: ['src/*.css']`. Files:

`justfile`:
```just
default:
    @just --list

serve-at PORT:
    wdk serve-dir _site {{PORT}}

build:
    rm -rf _site
    bunx @11ty/eleventy

check: build
    wdk compat
    wdk smoke
    wdk a11y
```
`package.json`:
```json
{ "name": "site", "private": true, "type": "module", "devDependencies": { "@11ty/eleventy": "^3.0.0" } }
```
`eleventy.config.js`:
```js
export default function (eleventyConfig) {
	eleventyConfig.addPassthroughCopy('src/style.css');
	return { dir: { input: 'src', output: '_site' } };
}
```
`src/index.html` and `src/style.css`: same as the static page/CSS.

- [ ] **Step 5: `flake.nix`** — add `eleventy = [ ];` after `static = [ ];` in `stacks`; add, inside `outputs`' attrset next to `devShells`:
```nix
      templates = nixpkgs.lib.genAttrs [ "static" "kirby" "eleventy" ] (name: {
        path = ./templates/${name};
        description = "web-dev-kit ${name} project";
      });
```
(`kirby` lands in Task 2; until then `nix flake check` would fail — do Task 2 before checking the flake.)

- [ ] **Step 6: Run** — `bun test test/templates.test.js` → PASS (static and eleventy).
- [ ] **Step 7: Commit** — `git add templates flake.nix test/templates.test.js && git commit -m "feat(templates): static and eleventy project templates"`

### Task 2: kirby template, flake check, docs

**Files:**
- Create: `templates/kirby/{flake.nix,justfile,wdk.config.js,.gitignore}`
- Modify: `test/templates.test.js`, `README.md`, `docs/roadmap.md`

- [ ] **Step 1: Failing test** — append to `test/templates.test.js`:
```js
test('template kirby: has its files and a parseable justfile', () => {
	const dir = project('kirby');
	for (const f of ['flake.nix', 'justfile', 'wdk.config.js', '.gitignore']) expect(await Bun.file(join(dir, f)).exists()).toBe(true);
	expect(sh('just', ['--list'], dir).code).toBe(0);
});
```
(make the test callback `async`.) Run → FAIL.

- [ ] **Step 2: Create the template.** `flake.nix` as static with `stack = "kirby"`. `justfile`:
```just
default:
    @just --list

# Kirby lives in ./kirby (git submodule add https://github.com/getkirby/kirby kirby).
serve-at PORT:
    php -S localhost:{{PORT}} kirby/router.php

# no build step
build:

check:
    wdk compat
    wdk smoke
    wdk a11y
```
`wdk.config.js`: as static but `compat.css: ['assets/css/*.css']` and add `proxy: { block: ['panel', 'api', '*.php'] }`. `.gitignore`: static's plus `/content/` and `/site/accounts/`... keep to `node_modules/`, `.wdk/`, `result`, `/vendor/`.

- [ ] **Step 3: Verify** — `bun test` (all) → PASS; `nix flake check --no-build` (skip if nix unavailable; say so).
- [ ] **Step 4: Docs** — README: add a "New project" section before "Use in a project": `nix flake init -t github:mstcgalis/web-dev-kit#<static|kirby|eleventy>`, one line each on what the stack's `serve-at`/`build` do. Roadmap §2: mark the templates bullet and the Eleventy build-stack bullet done for `eleventy` (Astro/Vite remain).
- [ ] **Step 5: Commit** — `git add templates test README.md docs/roadmap.md && git commit -m "feat(templates): kirby template; document templates"`

## Self-review

Spec coverage: flake output, three templates, test, README, roadmap — all covered; Kirby smoke dropped by stated deviation. No placeholders; `eleventy` stack key defined in Task 1 and used in its flake.nix.
