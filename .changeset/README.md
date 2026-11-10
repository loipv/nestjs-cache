# Changesets

Every pull request that changes the published package adds a changeset:

```bash
npx changeset
```

Pick the bump (`patch`, `minor` or `major`) and write one or two sentences for the CHANGELOG. Commit the generated
`.changeset/*.md` file with the pull request. Changes that do not reach npm users (tests, CI, docs outside the
package) need no changeset.

See the "Releasing" section of the main README for how releases are published.
