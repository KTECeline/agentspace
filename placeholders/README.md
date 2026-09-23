# Name reservation (placeholder 0.0.1 releases)

These two tiny packages reserve `agentspace` on PyPI and npm (see `docs/DECISIONS.md` D-006). They contain no code. Publish each one once, by hand, with your own credentials.

## PyPI

```bash
cd placeholders/pypi
uv build                                   # -> dist/agentspace-0.0.1-py3-none-any.whl + .tar.gz
uv publish --token "$PYPI_TOKEN"           # token from https://pypi.org/manage/account/token/
```

## npm

```bash
cd placeholders/npm
npm login                                  # once
npm publish --access public
```

Check that it worked: `pip index versions agentspace` and `npm view agentspace version` should both show `0.0.1`.

After this, add a trusted publisher (PyPI) and a granular automation token (npm) so the release workflow can publish real versions in Phase 5.
