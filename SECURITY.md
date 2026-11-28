# Security Policy

## Supported versions

Only the latest release published on [npm](https://www.npmjs.com/package/acpgram) receives security fixes.
Please update with `acpgram update` before reporting.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting: open the **Security** tab of the repository → **Report a vulnerability**
(<https://github.com/selesnow/acpgram/security/advisories/new>).

Please include the AcpGram version (`acpgram version`), your OS and Node.js version, the steps to reproduce,
and what an attacker could achieve. Do not include real bot tokens, API keys or `.env` files in the report.

You can expect an acknowledgement within a few days. After a fix is released, the report is published as a
security advisory and you are credited, if you wish.

## How the project is checked automatically

- **CodeQL** — static analysis of the JavaScript code (`.github/workflows/codeql.yml`).
- **Dependency review** and **Dependabot** — vulnerable dependencies and outdated GitHub Actions (`.github/dependabot.yml`).
- **OpenSSF Scorecard** — an automated check of the repository's security practices (`.github/workflows/scorecard.yml`).
- **Secret scanning** with push protection on the repository.
- GitHub Actions are pinned by commit SHA and run with minimal token permissions.
- The npm package is published from GitHub Actions with **provenance** (Trusted Publishing, no stored npm token),
  so the package can be traced back to the exact commit it was built from.
- The package has no runtime npm dependencies (ESLint is a development-only tool and is not installed with the package).
- Every GitHub Release file is signed with [Sigstore](https://www.sigstore.dev/) (keyless, `<file>.sigstore.json` next to it) and has a GitHub build-provenance attestation attached as `<file>.intoto.jsonl` (for OpenSSF Scorecard Signed-Releases). To verify a download:

  ```sh
  cosign verify-blob --bundle acpgram-vX.Y.Z.tar.gz.sigstore.json \
    --certificate-identity-regexp '^https://github.com/selesnow/acpgram/\.github/workflows/release\.yml@refs/tags/v' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    acpgram-vX.Y.Z.tar.gz

  gh attestation verify acpgram-vX.Y.Z.tar.gz -R selesnow/acpgram
  ```

## Scope and safety notes

AcpGram runs an AI coding agent on the machine where it is installed and lets Telegram users control it, so run it
on a machine and with an account you are comfortable giving that access to. Keep `.env` secret, set
`ALLOWED_USER_ID` to your own Telegram ID only, and review the access levels you grant to other users. See the README for the access model.
