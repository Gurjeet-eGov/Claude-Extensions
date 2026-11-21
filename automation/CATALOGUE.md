# Catalogue format

Two kinds of file live in this folder, both YAML:
- `suites/<id>.yaml`: one per automated suite. It says where the suite is, which version of it to run, how to run it and where its report lands.
- `environments/<name>.yaml`: one per environment a suite can run against.

Files whose name starts with `_` are examples and are never listed in Test Run.

## Suite file: `suites/<id>.yaml`

| Field | Required | What it is |
|---|---|---|
| `id` | yes | Short, unique, lower case with dashes, the same as the file name. Example: `pgr-playwright`. |
| `name` | yes | What people see in Test Run. |
| `team` | yes | The team that owns and maintains the suite. |
| `module` | yes | The product area it tests, for example `Complaints (PGR)`. |
| `framework` | yes | For people reading the catalogue: `playwright`, `cypress`, `selenium-java`, `pytest`, `karate`, `robot`, `k6`… |
| `repo` | yes | The suite's git repository, as you'd pass it to `git clone`. |
| `upstream` | no | The product repository it was forked from, if it was. For people; Test Run doesn't use it. |
| `setup` | yes | Shell command run once in the cloned folder to get it ready, for example `npm ci && npx playwright install chromium`. |
| `run` | yes | Shell command that runs the tests. It can use the placeholders below. A non-zero exit means "some tests failed" or "the run broke"; the report says which. |
| `report` | yes | Where the suite's own report is. See [Report](#report). |
| `versions` | yes | Which ref (tag or branch) to run for each product version and implementation. See [Versions](#versions). |
| `caseIds` | no | Reserved for later: how tests name the manual case they cover (for example `tag: "@{caseId}"`). Ignored for now. |

### Placeholders

`setup`, `run` and `report.build` are run with these environment variables set. A suite reads the ones it needs.

| Variable | Comes from |
|---|---|
| `BASE_URL` | the environment's `baseUrl` |
| `TENANT` | the environment's `tenant` |
| `IMPLEMENTATION` | the implementation picked for the run (empty for the default) |
| `OVERLAY` | the overlay folder for that implementation, if any |
| `PRODUCT_VERSION` | the product version picked for the run |
| `TAGS` | an optional filter typed when starting the run |
| each secret the environment names | the value stored on the host (never in git) |

### Report

The suite's own report, opened as it is. Give one of these:

| Field | What it is |
|---|---|
| `folder` | Folder (inside the cloned suite) that holds the HTML report after the run, with an `index.html`. |
| `build` | Optional command that builds that folder after the run, for example `npx allure generate allure-results -o allure-report --clean`. |
| `url` | Instead of a folder: the address where the team already publishes its report. Test Run links there and publishes nothing. |

When a report is published, its attachments (images, videos, traces, zips) are left out. See [Published reports](README.md#published-reports).

### Versions

A list, one entry per product version:

| Field | What it is |
|---|---|
| `product` | The product version, as a string: `"2.9"`. |
| `default` | The ref to run when no implementation is picked: a tag (preferred, repeatable) or a branch. |
| `setup`, `run` | Optional: overrides for this version, when the commands changed between versions. |
| `implementations` | Optional map, from implementation name to `{ ref, overlay }`. `ref` defaults to `default`; `overlay` is a folder in the suite repository with that implementation's settings and data. |

## Environment file: `environments/<name>.yaml`

| Field | Required | What it is |
|---|---|---|
| `name` | yes | What people see in Test Run, for example `Bomet UAT`. |
| `baseUrl` | yes | The address the suite tests. |
| `tenant` | no | Tenant or city code, if the product uses one. |
| `implementation` | no | Which implementation this environment runs (picks the matching entry in a suite's `implementations`). |
| `productVersion` | no | Which product version is deployed there (picks the matching entry in a suite's `versions`). |
| `secrets` | no | **Names** of the values a run needs, for example `[TEST_USER, TEST_PASSWORD]`. The values are kept on the host, never in git, and passed to the run as environment variables with these names. |
