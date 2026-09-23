# Name reservation (placeholder 0.0.1 releases)

These two tiny packages reserve the SDK names (see `docs/DECISIONS.md` D-006 and D-019). They contain no code. Publish each one once, by hand, with your own credentials.

| Registry | Package | Users write |
|---|---|---|
| PyPI | `agentspace-sdk` | `pip install agentspace-sdk`, then `import agentspace` |
| npm | `agentspace-sdk` | `npm i agentspace-sdk` |

We don't use plain `agentspace`: PyPI rejects it as too similar to the existing `agent-space`, and npm applies the same rule.

## PyPI

Create an account-scoped token at https://pypi.org/manage/account/token/ (2FA required). Then:

```bash
cd placeholders/pypi
read -s "PYPI_TOKEN?Paste PyPI token: " && export PYPI_TOKEN && echo   # zsh; keeps it out of history
uv build
uv publish --token "$PYPI_TOKEN"
```

## npm

1. Turn on 2FA for "Authorization and Publishing" at npmjs.com → Account.
2. Publish (no org needed; the package is unscoped):

```bash
cd placeholders/npm
npm login
npm publish --otp=123456        # the code from your authenticator app
```

## Check it worked

```bash
pip index versions agentspace-sdk     # 0.0.1
npm view agentspace-sdk version        # 0.0.1
```

Afterwards, swap the account-wide PyPI token for a project-scoped one (or a trusted publisher), so the release workflow can publish real versions in Phase 5.
