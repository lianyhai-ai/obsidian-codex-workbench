# Release Checklist

## Repository readiness

- [ ] `README.md` is up to date and includes disclosures
- [ ] `LICENSE` exists in the repository root
- [ ] `CHANGELOG.md` includes the release
- [ ] `manifest.json` version is updated
- [ ] `versions.json` contains the current manifest version mapping
- [ ] `npm run release:check` passes
- [ ] release assets are available in `build/release/`

## Obsidian community plugin readiness

- [ ] command names do not repeat the plugin name
- [ ] no default hotkeys are set
- [ ] no debug logging remains
- [ ] no hardcoded `.obsidian` assumptions are used for config paths
- [ ] background note writes use `Vault.process`
- [ ] `isDesktopOnly` is correct
- [ ] any network usage is clearly disclosed
- [ ] any local file access outside the vault is clearly disclosed
- [ ] any write behavior or approval behavior is clearly disclosed
- [ ] release assets contain `manifest.json`, `main.js`, and `styles.css`

## GitHub release steps

1. Update `manifest.json`
2. Run `npm run version`
3. Run `npm run release:check`
4. Commit and tag the release, for example `v0.1.0`
5. Push the branch and tag
6. Verify the GitHub release contains:
   - `manifest.json`
   - `main.js`
   - `styles.css`
   - optional checksum file

## Obsidian community submission

1. Fork `obsidianmd/obsidian-releases`
2. Add your plugin entry to `community-plugins.json`
3. Open a PR with:
   - plugin name
   - repository URL
   - short description
   - confirmation that the required release assets exist
4. Respond to reviewer feedback and update docs if needed

## Nice-to-have before submission

- [ ] screenshots or GIFs in `README.md`
- [ ] a short troubleshooting section
- [ ] a diagnostics command or settings page
- [ ] issue templates and release workflow verified on GitHub
