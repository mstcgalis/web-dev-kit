# web-kit roadmap: what is not built yet

The end goal is one CLI that takes a website from first prompt to deployed (stack, repo, domain,
VPS, CI) in minutes. It is built from scripts, not around any one agent. This file tracks every
piece that is decided or known but **not specced or built**, so nothing lives only in a chat log.

Specced so far: [`2026-10-05-kit-contract-and-checks-design.md`](superpowers/specs/2026-10-05-kit-contract-and-checks-design.md)
(module 0, thin, and module 1).

Build order: **1 → 3 → 4 → 2 (more stacks) → 5.** The CLI comes last: it only orchestrates
modules that already exist.

## 0. Repo contract: what the thin version leaves out

- **Shared agent/human rules.** Sonda's `AGENTS.md` mixes generic rules (one concern per commit,
  `just check` before commit, never commit secrets, server-owned state is untouchable, field names
  frozen) with Kirby specifics. Split it: the generic part ships in the kit and projects point at
  it; the stack part goes with the stack adapter.
- **`docs/` contracts.** Sonda has content, CSS and server contracts. Which are generic (the server
  contract is, through the vps module) and which are per project.
- **Branch and release model, written down:** `dev` → staging, `main` → production,
  fast-forward only, conventional commits, semver tags for the kit itself.
- **Fast mode** (sonda's `AGENTS.md`) as a kit-level convention or a per-project one.

## 2. Stack adapters

Specced: `kirby`, `static`. Missing:

- **Build stacks** (Eleventy, Astro, Vite): `build` produces `dist/`, `serve-at` runs
  `kit serve-dir dist`. dgalis.sk (Eleventy) is the first real case.
- **`nix flake init -t web-kit#<stack>` templates**: flake, justfile, `kit.config.js`, `.gitignore`,
  `AGENTS.md`. Owned by the CLI spec, but each stack needs one.
- **Each stack declares its deploy kind** (see 3).
- Open: does a stack adapter also pin its linters (Pint/PHPStan for Kirby, Prettier/ESLint for JS)?
  Probably yes, through the devShell, but this is undecided.

## 3. Deploy (in `~/src/vps`)

Decided: the vps flake takes each project flake as an input; the project exports
`nixosModules.default`; a deploy is a lock bump plus `switch`. The first site is dgalis.sk (static,
stateless); sonda follows once that path is proven.

Missing:

- **One parametrised `site.nix`** to replace `dgalis-sk.nix`, `sondafestival.nix` and
  `iloweit.nix`: domain(s), www redirect, Caddy vhost, TLS, the deploy user, PHP-FPM pool (Kirby),
  secrets via sops-nix, Umami site id.
- **Three deploy kinds:**
  - `store`: the build output is a Nix store path, served read-only. The target for static sites.
  - `store + state`: code in the store, mutable paths (`content/`, `media/`, sessions) in
    `/var/lib/<site>`, symlinked or configured. The target for sonda. Needs a migration from
    today's `git pull` deploy with zero content loss.
  - `pull` (today's sonda) and `rsync` (today's dgalis.sk): kept until each site moves.
- **Who triggers a deploy.** The project CI either dispatches to the vps repo, which bumps the lock
  and runs its existing CI apply, or the vps repo polls. The vps repo already has CI apply (D18) and a
  weekly flake-update job, so dispatch → lock-bump PR → auto-merge for staging is the likely shape.
- **Staging per site.** Sonda has staging on `dev`; how a generic site gets a staging vhost.
- **Content sync** (`content.just`, `docs/server-contract.md` §11 in sonda) generalised for stateful
  stacks: pull-first, dry-run, path-scoped push, merge-only.
- **DNS** through `tofu/dns` in vps: one record set per site from the same site entry.

## 4. CI/CD

Missing (this spec only moves sonda's test job to `nix develop -c just check`):

- **Reusable workflows in the kit** (`.github/workflows/*.yml` with `workflow_call`): test,
  deploy-staging (push to `dev`), deploy-production (push to `main`, after tests pass). Projects
  keep three thin caller files.
- **Nix caching in CI** (magic-nix-cache or a Cachix cache) so a cold Nix shell does not dominate
  CI time.
- **Deploy credentials:** which secret the project CI holds to dispatch to vps, scoped how.
- **Kit releases:** tag → each project bumps `inputs.kit`. Whether a bot opens those PRs, like the
  vps weekly flake update.

## 5. Bootstrap CLI

Missing entirely. Its likely steps, each calling an existing module:

1. Pick stack and name → `nix flake init -t web-kit#<stack>`, then `git init`.
2. `gh repo create`, then push `main` and `dev`.
3. Domain → a DNS records PR in vps `tofu/dns`. Registrar purchase is out of scope unless scripted
   later.
4. A site entry PR in vps (`site.nix` instance + flake input).
5. CI secrets set through `gh secret set`.
6. First deploy to staging; print the URLs.

Open: whether it is interactive (prompts), non-interactive (flags, so any agent or script can drive
it), or both. The "no specific agent" goal argues for flags first and prompts as a thin layer on top.
Also open: idempotency, i.e. re-running it on a half-bootstrapped project.

## 1. Checks: deferred inside the specced module

- **Static JS compat audit**: `smoke` in old engines covers real breakage. Add if a project ships
  JS to engines nobody can run.
- **Pixel diffs** against an approved baseline: only the contact sheet is planned.
- **Old Safari**: unreachable on current macOS. Add an old-macOS VM or a paid device cloud if a
  client needs it.
- **Old Chrome** (e.g. 116 via Chrome for Testing): the `exe:chrome` path is designed but
  unverified.
- **Perf on Linux** (`cpu.js` is macOS-only), and perf in CI: CPU on shared runners is noise, so
  this stays local unless self-hosted runners appear.
- **LAN gallery** (an index page of every page × variant): not chosen; `perf --serve` prints URLs.

## Housekeeping

- Rename this GitHub repo `web-checks` → `web-kit` (the redirect keeps sonda's `#v0.1.0` pin
  working).
- Sonda's `docs/perf.md` keeps its findings and the measurement traps; the traps move into the
  kit's README too, because they apply to every project.
