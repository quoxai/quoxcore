# Security policy

## Reporting a vulnerability

Email **security@quox.ai**. Please do not open a public issue for a security problem.

Include what you found, the version (see `VERSION`), steps to reproduce, and the impact you expect. We will acknowledge your report, keep you updated while we fix it, and credit you if you want credit.

Scope, our commitments and safe-harbour terms: [quox.ai/security](https://quox.ai/security#disclosure). Machine-readable contact: [security.txt](https://quox.ai/.well-known/security.txt).

## Supported versions

Security fixes go into the latest release published in this repository. Upgrade to it before reporting, if you can.

## Running QuoxCORE safely

- Keep the stack on a private network or behind your own reverse proxy with TLS. Do not expose service ports (auth, collector, tasks) directly to the internet.
- Treat the `.env` file the installer generates as a secret. It holds the keys the services use to trust each other.
- Connect model providers and integrations through the setup wizard or the vault, not by pasting keys into prompts or files in the repository.
