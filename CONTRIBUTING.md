# Contributing

Thanks for helping improve Codex Workbench.

## Local setup

```bash
npm install
npm run build
```

Bundled output is written to `build/main.js`.

## Development notes

- Keep the plugin desktop-only unless mobile support is intentionally added.
- Prefer Obsidian APIs over direct adapter access when possible.
- Use `Vault.process` for background note edits.
- Keep release artifacts out of the tracked repository root.
- If you introduce any networked behavior, document it in `README.md`.

## Before opening a pull request

Please make sure:

- `npm run build` passes
- release-facing docs are updated when behavior changes
- new settings or permissions are documented
- user-facing text uses sentence case where practical
- no debug logging or local absolute paths remain in docs

## Release-oriented changes

If your change affects installation, release assets, disclosures, or plugin permissions, also update:

- `README.md`
- `CHANGELOG.md`
- `docs/release-checklist.md`

## Reporting problems

- Use the GitHub bug report template for reproducible issues
- Include Obsidian version, OS, provider mode, and reproduction steps
