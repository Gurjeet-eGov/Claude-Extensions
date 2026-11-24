# Connect your test suite to Test Run

Test Run can start your automated tests in GitHub Actions and bring their results in, whatever the framework. Your repository keeps its own environments and secrets; Test Run only needs the repository's link, and runs its workflow.

This page shows how one suite is set up, gives a workflow to copy, and says how to link it. More detail, with snippets for each framework, is in [automation.md](automation.md).

## How CMS-Automation is set up

CMS-Automation is a working example:

- **One workflow, "Integration tests".** Its Run form has three fields: **environment** (where the tests run), **scope** (which tests; full by default) and **grep** (optional: only tests whose title or tags match).
- **One GitHub environment per deployment** (Settings → Environments), named after it, such as `naipepea`. Each environment has two secrets, and each secret is a whole file, pasted once:
  - `CONFIG_ENV`: the deployment's `config.env` (its address, tenant and so on);
  - `SECRETS_ENV`: the `secrets.env` (logins and passwords).
- **The run uploads its results** as a JUnit file, `results.xml`, in an artifact named **`test-results`**, kept 90 days. That is the file Test Run reads.

## A workflow to copy

Put this in your repository as `.github/workflows/integration-tests.yml`, then change the test command for your framework:

```yaml
name: Integration tests
on:
  workflow_dispatch:
    inputs:
      environment:
        description: Where the tests run (a GitHub environment)
        type: environment
        required: true
      grep:
        description: Only tests whose title or tags match (optional)
        type: string
jobs:
  test:
    runs-on: ubuntu-latest
    environment: ${{ inputs.environment }}
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Run the tests   # your framework's command: it must write JUnit XML or CTRF JSON into results/
        run: npx playwright test --reporter=junit ${GREP:+--grep "$GREP"}
        env:
          PLAYWRIGHT_JUNIT_OUTPUT_NAME: results/results.xml
          GREP: ${{ inputs.grep }}
          CONFIG_ENV: ${{ secrets.CONFIG_ENV }}
          SECRETS_ENV: ${{ secrets.SECRETS_ENV }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-results
          path: results/
          retention-days: 90
```

What matters to Test Run:

- **`workflow_dispatch`**, so Test Run can start it. The **environment** field has `type: environment`: Test Run's run form lists your repository's environments in it. Any other field you add (a choice, a checkbox, a text) shows in the run form too.
- **`environment: ${{ inputs.environment }}`** on the job, so the job gets that environment's secrets.
- **Secrets passed as `env:`** to the step that runs the tests. Your tests read them from there (or write them to the files they expect).
- **A results file**: JUnit XML or CTRF JSON, in `results/`. Most frameworks write JUnit XML; [automation.md](automation.md#snippets-per-framework) has the setting for each one. `${GREP:+--grep "$GREP"}` adds `--grep` only when the field is filled in.
- **The upload**: named `test-results`, with `if: always()` so failed runs upload too, kept 90 days (`retention-days`).

Then, on GitHub, in the repository's **Settings → Environments**: **New environment** for each deployment, and add its secrets (here `CONFIG_ENV` and `SECRETS_ENV`).

## Link it in Test Run

1. **Setup → Automation → Linked suites → + Add** (the host).
2. Paste the repository's link (`https://github.com/owner/repo`) and press **Check**.
3. Pick the **workflow** ("Integration tests"). Test Run picks the environment field by itself.
4. **Results artifact:** `test-results`.
5. **Save Suite.**

**▶ Run** then shows that workflow's own fields, as they are on the branch you choose, so a branch with a changed form runs with its own fields.

If the run form says the repository has no GitHub environments yet, add one as above. GitHub makes a `github-pages` environment by itself when Pages is switched on; the run form leaves it out (the host can change that list in **Setup → Automation → Exclude environments**).
