# Security Policy

## Reporting a vulnerability

Please do not disclose security-sensitive details in a public Issue or pull
request. Use [GitHub private vulnerability reporting](https://github.com/certainlyForgiveHer/dsh-compat-suite/security/advisories/new)
when available. If private reporting is unavailable, contact the repository
maintainer through GitHub and share only the minimum information needed to
establish a private channel.

Do not include credentials, tokens, session data, real DSH profiles, process
manager state, or unredacted logs in a report.

## Scope

The project treats DSH profiles, plugin packages, registry responses, process
supervisor state, and generated reports as security-sensitive inputs. The
default design is read-only and fail-closed: it must not install packages,
execute lifecycle scripts, restart a production DSH service, or widen browser
permissions.

## Supported versions

The `main` branch is the active development target. Release-specific support
will be recorded in the corresponding GitHub Release and package metadata.
