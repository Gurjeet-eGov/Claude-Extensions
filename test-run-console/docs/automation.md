# Automated suites in Test Run

Test Run keeps the results of automated tests next to the manual runs, whatever framework wrote them. It doesn't look at the framework at all: it reads one **results file**. This guide is for a QA who owns a suite and wants it in Test Run.

**New here?** [Connect your test suite to Test Run](connect-a-suite.md) is one short page: how CMS-Automation is set up, a workflow to copy, and how to link it.

- [What Test Run needs from a suite](#what-test-run-needs-from-a-suite)
- [The workflow, step by step](#the-workflow-step-by-step)
- [Snippets per framework](#snippets-per-framework)
- [Report link (optional)](#report-link-optional)
- [Linking the suite in Test Run](#linking-the-suite-in-test-run)
- [Running it from Test Run](#running-it-from-test-run)
- [Runs started elsewhere](#runs-started-elsewhere)
- [Troubleshooting](#troubleshooting)

## What Test Run needs from a suite

Four things, all in the suite's own repository:

1. **A results file**: **JUnit XML** (almost every framework writes it) or **CTRF JSON** (an open JSON standard that also carries retries and flaky tests). Test Run tells them apart by their content, not their name. Several files are fine: they make one run.
2. **Uploaded as an artifact**, named **`test-results`** by default (any name works; you pick it when linking). Keep the results in an artifact of their own: the full HTML report, videos and traces can go in another one. Upload with `if: always()`, so failed runs still upload.
3. **A `workflow_dispatch` trigger**, so Test Run can start the workflow. Its `inputs` become Test Run's run form: a `choice` becomes a dropdown, a `boolean` a checkbox, a `string` or `number` a text field, an `environment` a dropdown of the repository's environments (less those the host leaves out in **Setup → Automation → Exclude environments**: `github-pages` by default, which GitHub makes by itself when Pages is switched on). Each branch can have its own form: the run form shows the fields of the workflow file on the branch you run.
4. **Secrets in GitHub**, never in Test Run: put passwords and tokens in the repository's **Settings → Environments** (one environment per deployment, say `net_two`, `staging`) and pick the environment from an input. Test Run never sees them.

What Test Run keeps of each test: its title, file, suite, tags, status, time and retries, and for failures the message and the top of the stack (tokens, passwords and `Authorization` headers masked). No screenshots. The full report stays on the GitHub run; Test Run links to it (**↗ Git Report**: the suite's own published report when the run gives one, see [Report link](#report-link-optional), else the run on GitHub). The **?** next to it says how long GitHub keeps it: "Available until 8 Dec 2026.", the date GitHub gave for the results artifact when the run came in (set it with `retention-days`, at most 90). When no date is known (a results file, or a run brought in before Test Run kept the date), it says the artifacts are on GitHub for a limited time after the run, at most 90 days.

## The workflow, step by step

A complete example (Playwright; swap the test command for your framework, see below):

```yaml
# .github/workflows/integration.yml
name: Integration tests
on:
  schedule:
    - cron: '30 2 * * *'
  workflow_dispatch:            # lets Test Run start it
    inputs:
      environment:
        description: Deployment to test
        type: choice
        options: [staging, net_two, bomet]
        default: staging
      scope:
        description: Which tests
        type: choice
        options: [smoke, api, full]
        default: smoke
      grep:
        description: Only tests whose title or tags match
        type: string
        required: false

jobs:
  test:
    runs-on: ubuntu-latest
    environment: ${{ inputs.environment || 'staging' }}   # secrets come from this GitHub environment
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci && npx playwright install --with-deps
      - run: npx playwright test --grep "${{ inputs.grep }}"
        env:
          BASE_URL: ${{ vars.BASE_URL }}
          PASSWORD: ${{ secrets.PASSWORD }}
          PLAYWRIGHT_JUNIT_OUTPUT_NAME: results/junit.xml
      - uses: actions/upload-artifact@v4   # the results, for Test Run
        if: always()
        with:
          name: test-results
          path: results/
      - uses: actions/upload-artifact@v4   # the full report, for people
        if: always()
        with:
          name: playwright-report
          path: playwright-report/
```

Only the two marked parts matter to Test Run: `workflow_dispatch` (with any inputs you like) and the `test-results` artifact holding the JUnit or CTRF file.

## Snippets per framework

Each one writes a results file into `results/`; upload that folder as `test-results`, as above.

**Playwright** (JUnit; or CTRF with `playwright-ctrf-json-reporter`)

```js
// playwright.config.js
reporter: [['list'], ['junit', { outputFile: 'results/junit.xml' }], ['html', { open: 'never' }]],
```

**Cypress**

```js
// cypress.config.js
reporter: 'junit',
reporterOptions: { mochaFile: 'results/junit-[hash].xml' },
```

**Jest** (`npm i -D jest-junit`)

```bash
npx jest --ci --reporters=default --reporters=jest-junit
# with JEST_JUNIT_OUTPUT_DIR=results in the step's env
```

**pytest**

```bash
pytest --junitxml=results/junit.xml
```

**Maven / JUnit** (Surefire writes JUnit XML already)

```yaml
- run: mvn -B test
- uses: actions/upload-artifact@v4
  if: always()
  with: { name: test-results, path: target/surefire-reports/*.xml }
```

**TestNG** (with Maven, the same Surefire files; standalone, TestNG's own JUnit report)

```yaml
with: { name: test-results, path: test-output/junitreports/*.xml }
```

**Robot Framework**

```bash
robot --xunit results/xunit.xml tests/
```

**Karate** (runs on JUnit 5 with Maven: Surefire's files, as for Maven)

```yaml
with: { name: test-results, path: target/surefire-reports/*.xml }
```

**Newman** (Postman collections)

```bash
newman run collection.json -e env.json -r cli,junit --reporter-junit-export results/newman.xml
```

**Go** (`go install gotest.tools/gotestsum@latest`)

```bash
gotestsum --junitfile results/junit.xml ./...
```

**Anything else**: if it writes JUnit XML (most CI tools do) or CTRF JSON, it works. To check a file before linking, use **⤒ Import Results** on any suite: it reads the file and shows the counts before keeping anything.

**Case IDs.** To link automated tests to manual cases (for the Auto ✓ / ✗ marks), put the manual case's ID in the test's title or tags, like `@CMS/02`, and give the suite a case-ID pattern (`CMS/\d+`) when linking.

## Report link (optional)

If the workflow publishes its own report (on GitHub Pages, say), **↗ Git Report** can open it instead of the run on GitHub. After your publish step, write the report's address to `report-url.txt`, one line, and upload it as an artifact named **`report-link`** (only runs that published have it):

```yaml
      # after your publish step (here it has id: publish)
      - name: Write the report's address
        if: steps.publish.outcome == 'success'
        run: echo "https://your-org.github.io/your-repo/report/" > report-url.txt
      - uses: actions/upload-artifact@v4
        if: steps.publish.outcome == 'success'
        with:
          name: report-link
          path: report-url.txt
          retention-days: 90
```

When a run comes in (followed from **▶ Run**, **⤒ Import Results → GitHub Run**, or Link a suite's **⤒ Import Results**), Test Run reads the first line of `report-url.txt` and keeps it with the run, on the run page, in Summary › Automated and on the published site. It keeps only an `https://` or `http://` address of at most 500 characters, with no spaces; anything else is left out and the results still come in. Without a `report-link`, Git Report opens the run on GitHub.

## Linking the suite in Test Run

Once per repository, by the host: **Setup → Automation → Linked suites → + Add**. Choose the **Workbooks** the suite belongs to (the one open, to start with): its results, runs and runs going show only in those workbooks, and its runs attach only to them. A workbook with no suite has no Automation tab, and its Summary shows Manual only. The form opens in a popup; a suite's name in that list opens it again to change the suite, and so does **✎ Edit** on the Automation screen (for the host, and testers allowed to start runs).

1. **Repository**: paste the link (`https://github.com/owner/repo`) and press **Check**. Test Run reads it with the host's GitHub access, and lists its workflows; those that can be started by hand (with `workflow_dispatch`) can be picked.
2. **Workflow and results**: the name people see in Test Run; the **Workflow**; the **Results artifact** (Test Run looks inside the latest run's artifacts and shows which hold a results file; you can also type a name that isn't there yet); and, optionally, which input is the **environment** (runs are grouped by it, and the run form names it as the place secrets come from). An input of `type: environment` is picked by itself when none is chosen.
3. **Extras** (optional): the case-ID pattern.
4. **Try it**: choose a workbook › test suite › test cycle and press **Import Latest Run**. It saves the suite and brings in the latest finished run, so you see the counts straight away.

Then **Save Suite**. A suite can also be saved without a workflow: its results then come in only with **⤒ Import Results**.

Who sees a suite's results, and who may start runs, is set per person in **Setup → Access → Users**. The host sees **Setup → Automation**: the GitHub access Test Run has, how many runs are kept per test suite and cycle, how often a running run is checked, the GitHub environments the run form leaves out (**Exclude environments**: type a name and press Enter, ✕ removes one; `github-pages` to start with), and the linked suites, with **+ Add** to link another. The **i** next to a setting says what it does.

## Running it from Test Run

On the suite's page, **▶ Run** opens the run form: the branch, the workflow's own options, and (required) the workbook › test suite › test cycle the results belong to. **Start Run** starts the workflow on GitHub, exactly as its **Run workflow** button would.

The options are read from the workflow file **on the branch you choose**, and read again when you pick another branch: fields you already filled in stay, if that branch's form has them too. Only that branch's fields are sent, so a branch with a newer (or older) form runs with its own fields. If GitHub can't be read just then, the form saved when the suite was linked is used instead; when the default branch's form has changed, that saved copy is refreshed.

The **Running** view follows it: queued or running, the current job and its steps, the time so far, and **↗ GitHub Log**. The Automation tab shows how many runs are going. You can leave the page, or close the browser: the run goes on, and Test Run follows it even across a restart of Test Run. When it ends, the results artifact is read and the run is attached where you chose; the run view opens by itself. **Cancel Run** asks first, then asks GitHub to stop it.

If the run ends without its results (no artifact with that name, or no results file in it), Test Run says so, with a link to the run on GitHub.

GitHub's machines are free for public repositories; private ones use the plan's included minutes. A self-hosted runner works too: that's the workflow's `runs-on`, and Test Run doesn't mind.

## Runs started elsewhere

A scheduled run, a push, or the **Run workflow** button on GitHub: **⤒ Import Results → GitHub Run** lists the workflow's recent finished runs (those already in Test Run are marked) and brings one in. A file from a laptop or another CI: **⤒ Import Results → Results File**.

## Troubleshooting

| What you see | What to do |
|---|---|
| "GitHub didn't accept Test Run's access" | On the host laptop, run `gh auth login` (Setup → Automation shows who `gh` is signed in as). |
| "Test Run can't read the repository … can't see it" | The host's GitHub account needs access to the suite repository (read for Contents, read and write for Actions). |
| "… can't be started by hand" | Add `workflow_dispatch:` to the workflow's `on:` block, on the default branch. |
| "GitHub refused to let Test Run start the workflow" | The host's account needs Actions write on the suite repository. |
| "The run has no artifact named …" | Upload the results with the name chosen when linking (or change it in ✎ Edit), and use `if: always()`. |
| "… holds no JUnit XML or CTRF JSON results file" | The artifact holds something else: check the reporter's output path and the upload's `path:`. |
| "This repository has no GitHub environments yet" (in ▶ Run) | The workflow has an environment field, but the repository has no environments (or only ones the host leaves out). Add one in the repository's **Settings → Environments**: [Connect your test suite](connect-a-suite.md). |
| "GitHub didn't show the new run" | Very busy runners can take a while to list a run. Find it on the Actions page; once done, use ⤒ Import Results → GitHub Run. |

**For a later move to a token** (instead of the host's `gh` login), the token needs: on suite repositories, Actions read and write and Contents read; on this repository, Contents read and write and Actions write (publishing); on the account, Gists read and write (the shared address).
