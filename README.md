# workflows

Shared GitHub Actions for Merchbase services on the Mac mini.

`deploy-service.yml` updates a checkout that already exists on the runner. A shallow repo is unshallowed once. It then refreshes `origin/main` and refuses any SHA that is not an ancestor of `origin/main`, including when `explicit_ref` is true. A descendant SHA is fast-forwarded. Any other SHA is applied with `git reset --keep` when `explicit_ref` is true, and skipped otherwise. Health URLs must then return `"status":"ok"` and `"revision":"<sha>"`.

When `published_packages` is set, packages publish in that order. Each one must be visible on npm before the next publish. The workflow then pushes `v<version>` from the last entry and runs the version-bump backstop. An empty list skips both.

Pass `secrets: inherit`. The caller grants `contents: write`, `id-token: write`, and `packages: read`. The deploy job maps `GH_DEPLOY_AGENT_PRODUCTION_OP_TOKEN` to `DEPLOY_AGENT_PRODUCTION_OP_TOKEN`. The publish install step maps that same secret to `CI_OP_TOKEN`, so `publish_install_command` can resolve Development-vault install tokens (GitHub Packages, HugeIcons) the way Quality does. A custom command does not receive `github.token` as `MERCHBASE_GITHUB_NPM_TOKEN`. The release token stays on the npm publish step: `GH_RELEASE_AGENT_TOOLING_OP_TOKEN` is mapped to `release_token_env_name`, `release_switch_env_name` is set to `true`, and `MERCHBASE_NPM_PUBLISH_TOKEN` is read with `bunx varlock printenv` at the repo root. The repo `.npmrc` must reference that token. Publish runs `npm publish --access public`.

## Caller

The concurrency group is `<repo>-production`.

```yaml
name: Deploy
on:
  workflow_run:
    workflows: [Quality]
    types: [completed]
    branches: [main]
  workflow_dispatch:
    inputs:
      ref: { description: SHA on main to deploy. Set this to roll back., required: false, type: string }
permissions: { contents: write, id-token: write, packages: read }
concurrency: { group: my-service-production, cancel-in-progress: false }
jobs:
  resolve:
    if: github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    outputs:
      sha: ${{ steps.target.outputs.sha }}
      explicit_ref: ${{ steps.target.outputs.explicit_ref }}
    steps:
      - id: target
        env:
          REF: ${{ github.event.inputs.ref }}
          SHA: ${{ github.event_name == 'workflow_dispatch' && github.sha || github.event.workflow_run.head_sha }}
        run: |
          set -euo pipefail
          sha="${REF:-$SHA}"; explicit_ref=false; [ -z "$REF" ] || explicit_ref=true
          printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$' || { echo "Target must be a 40-character lowercase SHA." >&2; exit 1; }
          printf 'sha=%s\nexplicit_ref=%s\n' "$sha" "$explicit_ref" >> "$GITHUB_OUTPUT"
  deploy:
    needs: resolve
    uses: merchbaseco/workflows/.github/workflows/deploy-service.yml@v1
    secrets: inherit
    with:
      sha: ${{ needs.resolve.outputs.sha }}
      explicit_ref: ${{ needs.resolve.outputs.explicit_ref == 'true' }}
      production_checkout: /Users/me/srv/my-service
      deploy_command: bun run deploy
      # Liveness only: /health/live or /api/live. Never strict /api/health.
      # /api/health reports data freshness and can be degraded right after a deploy or downtime.
      health_urls: https://my-service.example/health/live https://my-service.example/api/live
      published_packages: packages/client:@scope/client
      bun_version: "1.4.2"
      prepublish_command: bun run release:check && bun run build
      release_token_env_name: RELEASE_AGENT_TOOLING_OP_TOKEN
      release_switch_env_name: MY_SERVICE_RESOLVE_RELEASE_TOKENS
```

## Inputs

| Input | Default | Role |
| --- | --- | --- |
| `sha` | required | 40-character lowercase commit from the caller |
| `explicit_ref` | `false` | Allow a SHA that is not a descendant of the checkout |
| `production_checkout` | required | Absolute path of the git checkout on the runner |
| `deploy_command` | required | Command run in that checkout after install |
| `install_command` | `bun install --frozen-lockfile` | Install before deploy. Also the publish install when `publish_install_command` is empty |
| `publish_install_command` | `install_command` | Publish-job install. The step sets `CI_OP_TOKEN`. Example: `. ./scripts/install-tokens && bun install --frozen-lockfile` |
| `health_urls` | required | Space-separated liveness URLs (`/health/live` or `/api/live`). Each body must include `"status":"ok"` and `"revision":"<sha>"`. Never strict `/api/health`: it reports data freshness and can be degraded right after a deploy or downtime even though the deploy is fine |
| `health_timeout_seconds` | `180` | Stop polling after this many seconds |
| `runner` | `self-hosted` | `runs-on` for deploy, the backstop, and publish when provenance is off |
| `published_packages` | empty | `dir:name,dir:name` in dependency order. Empty skips publish and the backstop |
| `publish_provenance` | `true` | `true`: `ubuntu-latest` and `--provenance`. `false`: `runner` and `--provenance=false` |
| `bun_version` | empty | Bun version for publish. Required when a listed package is missing on npm |
| `prepublish_command` | empty | Shell command after install and before the npm token is resolved |
| `release_token_env_name` | empty | Env name that receives `GH_RELEASE_AGENT_TOOLING_OP_TOKEN`. Required to publish |
| `release_switch_env_name` | empty | Env name set to `true` before varlock. Required to publish |

## Published package version bump

`published-package-bump.yml` fails a PR that changes a file a published package ships without bumping that package's version. Run it from Quality so the deploy backstop never has to catch it.

It diffs `HEAD` against its merge-base with the base. On a pull request the base is the first parent of GitHub's merge ref, which is the base tip the PR was merged onto. A push compares against its `before` commit, or the previous commit when that is gone after a force-push. A merge group compares against its base. The shipped scope is the `npm pack --dry-run --json --ignore-scripts` file list plus `package.json`, at both the base and the head so deleted files count. CI has not built anything, so a `files` entry with nothing behind it in the pack list is unbuilt output, and the source behind it counts as shipped. With `source_dirs`, that source is the listed dirs. When the tsconfig `outDir` covers the entry, it is `rootDir`, read through relative `extends`, or else the shared root of `include`. Otherwise, as with `bun build` and no tsconfig, it is the whole package. Test files (`*.test.*`, `*.spec.*`, `test/`, `tests/`, `__tests__/`, `__mocks__/`) and fixtures never count toward that source scope.

A package passes when no shipped file changed, when its version changed, when it is new in the change, or when the base version is not on npm yet, since the next publish already carries the change. A dir with no `package.json`, a name that does not match it, or an npm error other than a 404 fails the job. Nothing is installed. The job uses Node built-ins, `git`, and `npm`, with `contents: read` and no secrets, so it is safe on pull requests from forks.

```yaml
jobs:
  published-package-version-bump:
    uses: merchbaseco/workflows/.github/workflows/published-package-bump.yml@main
    with:
      published_packages: packages/http-client:@scope/http-client,packages/cli:@scope/cli
      # Optional. Narrows a bun-built package from "everything but tests" to its source.
      source_dirs: packages/cli:src
```

| Input | Default | Role |
| --- | --- | --- |
| `published_packages` | required | `dir:name,dir:name`, the same value `deploy-service.yml` takes |
| `source_dirs` | empty | `dir:path,dir:path` naming the source behind each package's unbuilt output, relative to the package. Empty infers it as above |
| `base_ref` | empty | Commit to compare against. Empty uses the PR base, the merge group base, or the push's previous commit |
| `workflows_ref` | empty | `merchbaseco/workflows` commit that supplies the script. Empty uses the ref the caller pinned |

Run it locally from a caller checkout with `node scripts/check-published-package-bump.mjs --packages "<dir:name,...>" [--source-dirs "<dir:path,...>"] --base origin/main`, using the script from this repo.
