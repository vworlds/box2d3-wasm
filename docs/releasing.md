# Releasing and CI setup

## How a release works

Merging `dev` into `master` runs `.github/workflows/publish.yml`:

1. build both flavours, run `gen:check`, `check:bindings`, `test:release`, `npm test`, `npm run test:stock` and the
   pack content check (the vecs suites do not run here; they are in CI and the nightly run);
2. `scripts/release-version.mjs` asks the npm registry whether the version in `package.json`
   exists. If not, that version is released as is. If it does, the patch version is bumped;
3. a bump is committed to `master` as `chore: release <version> [skip ci]`; the tag `v<version>` is
   pushed;
4. `npm publish --provenance --access public`.

For a minor or major release, change `version` in `package.json` on `dev` before merging. Check the
decision any time with `node scripts/release-version.mjs --dry-run`.

The bump commit stays on `master`; nothing merges it back to `dev` (vecs does the same). The next
`dev` -> `master` merge keeps the higher version unless `dev` edited the same line. If you want `dev`
to show the released version, merge `master` into `dev` yourself.

If the publish step fails after the bump was pushed, re-run the job: the version in `package.json`
is then unpublished and is released as is (an existing tag is left alone).

## One-time setup, in order

1. **`NPM_TOKEN` secret, for the first release.** A package that does not exist on npm cannot have
   a trusted publisher yet. On npmjs.com create a granular access token with read and write
   access to the `@vworlds` scope (publishing a new package needs the scope), then add it in
   *Settings > Secrets and variables > Actions > New repository secret* as `NPM_TOKEN`.
2. **Merge `dev` into `master`.** 6.0.0 is released as is, with provenance.
3. **Trusted publisher, after 6.0.0 exists.** On npmjs.com open the package *Settings > Trusted
   Publisher > GitHub Actions*: organisation `vworlds`, repository `box2d3-wasm`, workflow
   filename `publish.yml`, no environment. Then **delete the `NPM_TOKEN` secret** (and revoke the
   token on npm). The workflow then publishes with an empty token over OIDC. Trusted publishing
   needs npm 11.5.1 or newer; Node 24 ships it.
4. **`VECS_READ_SECRET` secret.** vecs is private. Create a fine-grained personal access token with
   resource owner `vworlds`, repository access *only* `vworlds/vecs`, and permission *Contents:
   Read-only* (Metadata read is added automatically). Add it as the repository secret
   `VECS_READ_SECRET`. Without it the vecs job in CI and the nightly run print a warning and are
   skipped; they do not fail. Pull requests from forks never see it.
5. **Pages source.** *Settings > Pages > Build and deployment > Source: GitHub Actions*. Pages
   deploys from `master`, but the `github-pages` environment may only allow the default branch
   (`dev`): in *Settings > Environments > github-pages > Deployment branches and tags* add `master`.
6. **Let Actions create pull requests.** *Settings > Actions > General > Workflow permissions >
   "Allow GitHub Actions to create and approve pull requests"*. The nightly run needs it to open
   the pull request that moves `ci/vecs-ref`. Pull requests and pushes made with the workflow token
   do not start other workflows, so CI does not run on that pull request by itself: push an empty
   commit to its branch (`automation/vecs-ref`) from your own account, or close and reopen it, if
   `dev` requires the CI checks to merge.
7. **Branch protection on `master`.** The publish job pushes a commit and a tag with the workflow
   token (`github-actions[bot]`). If `master` requires pull requests or status checks, either
   exempt the bot (a ruleset with *GitHub Actions* as a bypass actor, or "Allow specified actors to
   bypass required pull requests"), or the bump push fails after the tests passed. Also allow tag
   creation for `v*` (tag rulesets must not block the bot). Merging `dev` into `master` itself
   should require CI to be green.

## Pinning vecs

`ci/vecs-ref` holds the full commit sha of vecs that CI tests against. The nightly run proposes
moving it; you can also edit it by hand. To run the suites locally:

```sh
npm run build && npm pack
scripts/run-vecs-suites.sh ../vecs vworlds-box2d3-wasm-*.tgz
```

The vecs checkout must be clean (the suites run from source, so it must not contain `dist`
directories). The script runs `npm ci` in it and replaces `node_modules/box2d3-wasm` with a real
copy of the package.

## Build environment

The emsdk version (4.0.18) is set in one place, `.github/actions/build/action.yml`, which installs
it with `mymindstorm/setup-emsdk` (cached under `emsdk-cache`) and installs TypeScript 5.9 with
`npm install --global typescript@5.9`. Do not change the emsdk version together with anything
else; see [box2d-update.md](box2d-update.md).
