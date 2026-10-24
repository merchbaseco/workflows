# workflows

Shared GitHub Actions for Merchbase services on the Mac mini.

`deploy-service.yml` updates a checkout that already exists on the runner. A shallow repo is unshallowed once. A descendant SHA is fast-forwarded. Any other SHA is applied with `git reset --keep` when `explicit_ref` is true, and skipped otherwise. Health URLs must then return `"status":"ok"` and `"revision":"<sha>"`.

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
