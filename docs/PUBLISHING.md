# Publishing dsh-herdr

Notes for maintainers on getting this project into other people's hands.

## 1. Create the public repository

Pick a name (for example `dsh-herdr`), a license (Apache-2.0 is what this repo
uses, matching Herdr's license and the copied program icon), and an owner.

```sh
cd dsh-herdr
git init -b main
git add .
git commit -m "Initial public release"
# create the public repo and push in one step (GitHub CLI, logged in):
gh repo create mitkox/dsh-herdr --public --source=. --remote=origin --push
```

Before the first push, update the placeholder URLs in:

- `README.md` (clone URL, any badges you add),
- `package.json` (`repository`, `homepage`, `author`, `contributors`),
- `plugin/package.json` (`repository`, `homepage`, `author`).

This repository is already configured for `mitkox/dsh-herdr`; edit those fields
if you fork it under a different owner. The unscoped npm name `dsh-herdr` is
taken by an unrelated package, so the npm package uses the `@mitkox` scope.

## 2. Tag the release

```sh
git tag -a v0.3.0 -m "dsh-herdr 0.3.0"
git push origin main --tags
```

Add `CHANGELOG.md` entries for each release.

## 3. Publish the npm package (optional)

The launcher can be installed with `npm install -g dsh-herdr`, which also ships
the app mod, the plugin and the installer:

```sh
npm pack --dry-run        # review the file list
npm publish --access public
```

The package name may be taken; use a scope you own (`@you/dsh-herdr`) and update
the README instructions accordingly. `npm test` runs in CI before you publish.

## 4. Publish the DSH host plugin (optional, separate package)

The `plugin/` directory is a standalone DSH bundle (`dsh.bundle.patch`). Two ways
for other people to install it:

- **Git source** (no registry needed): `dsh plugin --profile herdr add <repo-or-path>`
  — the DSH plugin market can also index a Git repository that contains a bundle
  package; see the DSH `apps/plugin-market-generator` reference for what an
  index generator reads.
- **npm**: publish from `plugin/` (`npm publish`) after setting `repository`,
  `author` and a `dsh` engine range, then users run
  `dsh plugin --profile herdr add <package-name>`.

Keep `plugin/package.json` `private: true` and publish only when you intend to
maintain the registry package.

## 5. Get it listed / seen

- **Herdr community gallery** — <https://herdr.dev/gallery>: layouts and mods
  from GitHub repositories. The panel mod here depends on the launcher, so it is
  best listed as part of this project (the mod itself is a normal Herdr mod and
  can be copied by anyone following `app/README.md`). "Share yours" on the
  gallery page is the submission path; include a screenshot and a repo link.
- **DSH plugin market / index** — a market index can list npm packages or Git
  repositories whose manifests declare `dsh.bundle.patch`; this repository
  qualifies via `plugin/`. Add it to whichever index your DSH install uses.
- **Announce** where the two communities are: Herdr Discord/GitHub discussions,
  DSH issues/discussions. Show the screenshot, one command to install, and be
  explicit that it is read-only and needs no dsh restart for the default path.

## 6. Screenshots and demos

- Retake the screenshots on a clean demo session if the current ones show your
  own work (no tokens, no private session titles).
- A short terminal recording of `install.sh --start` → agent row appearing →
  `mod.open` panel is the most convincing asset; keep it under ~15 s.

## 7. Release checklist

- [ ] `npm test` green locally and in CI (Linux + macOS)
- [ ] `herdr-app check app/mods/dsh-monitor` passes on the app version you support
- [ ] README install steps verified on a clean machine or fresh `HERDR_APP_HOME`
- [ ] no secrets, tokens, personal paths or private session text committed
      (`git grep -InE 'token=|api[_-]?key|/home/|@' -- .` as a quick pass)
- [ ] LICENSE/NOTICE accurate; dependencies remain license-compatible
- [ ] CHANGELOG updated, version bumped, tag pushed
- [ ] uninstall paths tested
