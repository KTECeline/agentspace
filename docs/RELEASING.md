# Releasing

Pushing a `v*` tag runs `.github/workflows/release.yml`:

1. **check**: every package's version must match the tag (`scripts/version.py check`), or nothing is published.
2. **pypi**: builds and publishes `agentspace-sdk` to PyPI, using trusted publishing.
3. **npm**: tests, builds and publishes `agentspace-sdk` to npm, using trusted publishing with provenance. Pre-releases go to the `next` dist-tag.
4. **images**: builds `ghcr.io/<owner>/agentspace-collector` and `agentspace-web` for amd64 and arm64, with provenance and an SBOM, tagged `X.Y.Z`, `X.Y` and `latest`. Pre-releases get only `X.Y.Z-rc.N`.
5. **github-release**: creates the GitHub release with generated notes, once all of the above succeed.

No registry token is stored anywhere. PyPI and npm trust this workflow through OIDC, and GHCR uses the job's `GITHUB_TOKEN`.

## One-time setup (the maintainer, in the web UIs)

The `agentspace-sdk` names already exist on both registries (0.0.1 placeholders, D-019), so the first real release publishes on top of them.

1. **GitHub environments.** In Settings → Environments, create `pypi` and `npm`. Add yourself as a **required reviewer** on both, so every publish waits for your click.
2. **PyPI trusted publisher.** On pypi.org → `agentspace-sdk` → Settings → Publishing → Add a GitHub publisher:
   - owner `KTECeline`, repository `agentspace`;
   - workflow `release.yml`, environment `pypi`.
3. **npm trusted publisher.** On npmjs.com → `agentspace-sdk` → Settings → Trusted Publisher → GitHub Actions:
   - organization or user `KTECeline`, repository `agentspace`;
   - workflow file `release.yml`, environment `npm`.

   Then, under Publishing access, choose "Require two-factor authentication and disallow tokens".
4. **GHCR visibility.** After the first release, open each package under your GitHub profile → Packages and set its visibility to **public**. New packages start private.

Provenance on npm, and PyPI attestations, need the repository to be **public** when the release runs.

## Cutting a release

```bash
git switch main && git pull
python3 scripts/version.py set 0.1.0            # or 0.2.0-rc.1 for a pre-release
for d in examples/*/; do (cd "$d" && VIRTUAL_ENV= uv lock); done   # examples lock the SDK version
make test && make lint typecheck
# Update spec/CHANGELOG.md if the spec changed, and docs/PROGRESS.md.
git commit -am "chore: release 0.1.0"
git tag -a v0.1.0 -m "v0.1.0"
git push && git push origin v0.1.0
```

Then approve the `pypi` and `npm` deployments in the Actions tab.

## After it's out

```bash
pip install agentspace-sdk==0.1.0 && python -c "import agentspace; print(agentspace.__version__)"
npm view agentspace-sdk@0.1.0 version
docker pull ghcr.io/ktececline/agentspace-collector:0.1.0
```

Set the next development version: `python3 scripts/version.py set 0.1.1-dev.0`, then re-lock and commit.

## If something went wrong

- **The version check failed:** nothing was published. Fix the versions, move the tag (`git tag -f v0.1.0 && git push -f origin v0.1.0`) and it runs again.
- **Bad PyPI release:** *yank* it (PyPI → Manage → Releases → Yank). You can never reuse a version number, so release `0.1.1`.
- **Bad npm release:** `npm deprecate agentspace-sdk@0.1.0 "use 0.1.1"`. Unpublishing is only possible within 72 hours and is discouraged.
- **Bad image:** push a fixed tag. `latest` moves with the next release.
