# Contributing to Komla

Thanks for helping. Bug reports, fixes and new features are all welcome.

## Before you start

For anything bigger than a small fix, open an issue first, so we can agree on the approach before you spend time on it.

## Development setup

Follow [Build from source](README.md#build-from-source). `npm run dev` runs Komla with its data in `~/.komla-dev`, apart from any Komla you have installed.

`npm install` turns on a pre-commit hook that rejects unformatted `src/` files; `npm run format` fixes them. It keeps any `core.hooksPath` or `.git/hooks` you already use, and `git commit --no-verify` skips it once.

[AGENTS.md](AGENTS.md) describes the architecture and which checks each kind of change needs. It is written for coding agents, and it is also the best map of the codebase for people.

[docs/RELEASING.md](docs/RELEASING.md) covers official releases, which need the maintainers' signing and upload credentials. You don't need it to build or test Komla.

## Pull requests

- Keep each pull request to one change, and say what it does and why.
- Add or update tests. For a bug fix, include a test that fails without the fix.
- Run the checks AGENTS.md lists for the parts you changed. `npm test` covers most changes.
- Komla runs on macOS, Windows and Linux. Say which of them you tested on.

## License

By submitting a pull request, you agree to license your contribution under the [MIT License](LICENSE), the same license as the rest of Komla.

## Security issues

Please don't open a public issue for a vulnerability. [SECURITY.md](SECURITY.md) says how to report one privately.
