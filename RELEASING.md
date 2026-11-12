# Releasing

Versions and the CHANGELOG are managed with [Changesets](https://changesets.dev).

[Back to the README](README.md)

What counts as a major, minor or patch change is defined in [the semver contract](docs/semver.md). Pick the bump
against it.

1. A pull request that changes the published package runs `npx changeset`, picks `patch`, `minor` or `major`, and
   commits the generated `.changeset/*.md` file. Tests, CI and docs-only changes need none.
2. When CI passes on `main`, the `Release` workflow opens or updates a "Version Packages" pull request that bumps
   `package.json` and `package-lock.json` and writes the CHANGELOG entry.
3. Merging that pull request runs CI again. When it passes and the version in `package.json` is not on npm yet, the
   workflow publishes it with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, with provenance,
   no npm token) and creates the `v<version>` git tag and GitHub Release.

The workflow only releases the commit that CI tested: if `main` has moved on by the time CI finishes, that run does
nothing and the newer commit's run takes over. Nothing is released while CI on `main` is red.

One-time setup for maintainers, in this order:

1. Publish the current version by hand and push its tag. npm only allows a trusted publisher once the package
   exists. Do this before the release workflow first runs on `main`, or that run will try to publish the unpublished
   version and fail.

   ```bash
   npm run build && npm publish
   git tag v0.3.0 && git push origin v0.3.0
   ```

2. On npmjs.com, add a trusted publisher to `@loipv/nestjs-cache`: GitHub Actions, repository `loipv/nestjs-cache`,
   workflow `release.yml` (exact file name), no environment.
3. In the GitHub repository, enable Settings > Actions > General > "Allow GitHub Actions to create and approve pull
   requests".
4. Protect `main` with a branch ruleset that requires pull requests and the `ci-ok` status check. `ci-ok` is an
   aggregate job in `ci.yml` that fails unless every other CI job and matrix cell succeeded, so it is the only check
   to require. It always runs, so a failed, skipped or cancelled job fails it instead of being counted as passing.
5. The "Version Packages" pull request is opened with the workflow's `GITHUB_TOKEN`, so CI does not run on it. Allow
   the maintainer to bypass the `ci-ok` requirement for that pull request (or exempt the `changeset-release/main`
   branch). The pull request only changes versions and the CHANGELOG, and CI runs on `main` after it is merged, before
   anything is published.

Workflow rules, enforced by `npm run check:workflows` in CI:

- Every action is pinned by full commit SHA with a `# vX.Y.Z` comment, because tags can be moved and the release jobs
  hold write permissions and the OIDC token. Dependabot (`.github/dependabot.yml`) proposes new pins weekly; read the
  upstream release notes before merging one.
- Every install runs with `--ignore-scripts`, so no dependency lifecycle script runs in CI or next to the release
  permissions. If a new dependency only works after its install script, CI fails first; run that package's script
  alone (`npm rebuild <package>`) in the job that needs it instead of dropping the flag.
- Every job has `timeout-minutes`. When you add a job to `ci.yml`, add it to `ci-ok`'s `needs`.

`npm run check:pack` (tarball contents) and `npm run check:pkg` (`publint` and `attw`) also run in CI and in
`prepublishOnly`.
