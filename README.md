# web-checks

Shared test tooling for web projects. For now, one command: an
[axe-core](https://github.com/dequelabs/axe-core) crawl. It starts from a few paths, follows every
same-origin link, runs axe (WCAG 2.2 AA + best practices) on each page in headless Chromium, and
exits 1 on any violation.

## Install

```
bun add -d github:mstcgalis/web-checks#v0.1.0 playwright
bunx playwright install chromium-headless-shell
```

Playwright is a peer dependency, so the project picks its version and installs the browser.
Pin a tag and upgrade on purpose.

## Use

A built static site (Eleventy `_site`, Vite/Astro `dist`), served by bun the way static hosts do
(`/x` → `x`, `x.html`, `x/index.html`; otherwise `404.html` with status 404):

```
web-checks a11y --dir dist
```

Anything with its own server; `{port}` is substituted:

```
web-checks a11y --serve "php -S localhost:{port} tests/a11y/router.php" --start / --start /cs
```

| Flag | Default | |
|---|---|---|
| `--dir` / `--serve` | — | exactly one |
| `--port` | `8798` | |
| `--start` | `/` and `/does-not-exist` | repeatable; replaces the default |
| `--skip` | — | regex on the pathname; file extensions are always skipped |
| `--limit` | `80` | crawl cap |

Wire it into the project's `just check` and CI as a plain recipe:

```
a11y:
    bunx web-checks a11y --dir dist
```

## Develop

`just check` runs `bun test`, which drives the CLI against `test/site/`.

## Licence

AGPL-3.0.
