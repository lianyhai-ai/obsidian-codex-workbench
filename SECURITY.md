# Security

## Supported versions

Security fixes are intended for the latest released version.

## Reporting a vulnerability

Please do not open a public issue for security-sensitive problems.

Instead, report:

- the affected version
- the environment
- reproduction steps
- the expected and actual behavior
- whether the issue involves local file access, remote endpoints, or approval handling

If you do not yet have a private reporting channel configured, create one before public release.

## Security notes for users

- `Local Codex` mode starts a local process on your machine.
- `workspace-write` mode can request permission to edit files.
- remote provider modes send content to the endpoint you configure.
- this plugin does not include telemetry or analytics.
