# Security Policy

## Credentials & Private Data
- **Never commit** `.env`, exchange API keys/secrets, Telegram bot tokens, Telethon `.session` files, SSH private keys, or live/testnet trading ledgers (`store.json`, `*ledger*.json`, `scalp-journal*.jsonl`) to this repository.
- Exchange API keys used locally must have **withdrawal permissions disabled** and IP restrictions enabled where supported.
- Live and testnet execution reports are stored separately in a **private** repository (`signal-lab-reports`), never here.

## Auto-Update Trust Boundary
- The Windows auto-updater (`windows-update-source.mjs`) exclusively accepts commits on `Rmsidrmfo3531/signal-lab` branch `main` triggered by `push` events whose required CI jobs all pass. External pull requests and forks are never trusted or installed.

## Reporting a Vulnerability
- Please report security issues privately via GitHub Security Advisories rather than opening a public issue.
