# Release checklist for the package author

This checklist is for the package author. It does not grant permission to publish from this workspace. Stop after preparing and validating the tarball; the author decides when to run `npm publish`.

## Validate and pack

1. Use Node.js 22.19+ and pnpm 11.7.0; install dependencies with `pnpm install --frozen-lockfile`.
2. Run `pnpm run check`, `pnpm run test:integration`, and `pnpm run test:smoke`.
3. Run `pnpm pack` and inspect the generated `dsh-free-router-0.1.3.tgz`. It should include the built `dist` command module and both `README.md` and `docs/README.zh-CN.md`.
4. Install the tarball into a temporary DSH profile:

   ```bash
   dsh plugin --profile <temporary-profile> add file:/absolute/path/dsh-free-router-0.1.3.tgz
   ```

## Verify Desktop DSH 0.2.0-rc.2

1. In the temporary profile, accept the exact compatibility exception:

   ```bash
   dsh plugin --profile <temporary-profile> allow-version dsh-free-router@0.1.3 --dsh-version 0.2.0-rc.2 --accept-risk
   ```

2. Open the Desktop app with the temporary profile and run `/free-router refresh`. Confirm the command reports refresh counts, registration outcome, model additions/removals, and sanitized failure codes.
3. Run `/free-router status` and confirm it shows the latest report without initiating another refresh.
4. Review both READMEs for the default zero-price discovery switch, Tier `?`, meta-router exclusion, and provider logging/training privacy note.

## Publish decision (author only)

After all checks and Desktop verification pass, the package author may run `npm publish`. Do not publish from automated preparation or validation steps.
