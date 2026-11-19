# Allure Report Storage

The Allure Report Storage service allows to publish Allure Report reports to and seamlessly integrates with history feature, making possible to see previous reports in a single click.

[<img src="https://allurereport.org/public/img/allure-report.svg" height="85px" alt="Allure Report logo" align="right" />](https://allurereport.org "Allure Report")

- Learn more about Allure Report at https://allurereport.org
- 📚 [Documentation](https://allurereport.org/docs/) – discover official documentation for Allure Report
- ❓ [Questions and Support](https://github.com/orgs/allure-framework/discussions/categories/questions-support) – get help from the team and community
- 📢 [Official annoucements](https://github.com/orgs/allure-framework/discussions/categories/announcements) – be in touch with the latest updates
- 💬 [General Discussion](https://github.com/orgs/allure-framework/discussions/categories/general-discussion) – engage in casual conversations, share insights and ideas with the community

## Usage

![Allure Report Storage service preview](./public/cover.png)

The service integrates seamlessly with Allure3, you just need to do these 4 simple steps:

1. Run the service using it [inside Docker](#docker) or as [a Cloudflare worker](#cloudflare)
2. Generate access token [using REST API](#access-token-generation)
3. Add token to the Allure runtime config
4. Add `publish` flag to the options of reports which should be published

## Installation

### Docker

Continue reading [here](https://github.com/allure-framework/allure-report-storage/blob/main/docs/docker.md).

### Cloudflare

Continue reading [here](https://github.com/allure-framework/allure-report-storage/blob/main/docs/cloudflare.md).

## Usage

### Access token generation

Generate access token using the Storage API first (use access token previously passed to the service env variable):

```bash
curl -sS -X POST http://localhost:3000/api/token \
  -H "Authorization: Bearer storage_bootstrap_token"
```

If the service is behind TLS termination or a reverse proxy, [set `PUBLIC_URL`](#public-url) before generating the token.

Then use it in the Allure Report runtime config:

```diff
import { defineConfig } from "allure";

export default defineConfig({
  name: "Allure Report",
  plugins: {
    awesome: {
      options: {
+       publish: true, // explicitly specify which reports should be published
      },
    },
  },
+  allureService: {
+    accessToken: "ars1...",
+  },
});
```

### Public URL

`PUBLIC_URL` optionally overrides the origin embedded in newly generated `POST /api/token` access tokens. Set it when the request origin is not the public URL clients use, for example when TLS terminates at a reverse proxy:

```bash
PUBLIC_URL=https://reports.example.com
```

It does not change the server listening address or authentication. If it is unset, empty, or whitespace-only, the service uses the request origin instead.

The value must be an absolute HTTP(S) origin. A port and trailing slash are accepted; outer whitespace is trimmed and the value is normalized to its URL origin. Credentials, a path other than `/`, a query, and a fragment are not allowed.

Existing tokens retain the URL embedded when they were generated. Regenerate affected tokens after setting `PUBLIC_URL`, then replace them in client and CI configuration.

### Main branch selection

If your main branch doesn't call `main`, you can specify a custom one to compare reports from another branches with:

```bash
curl -sS -X POST http://localhost:3000/api/projects/main-branch \
  -H "Authorization: Bearer dev-bootstrap-token" \
  -H "Content-Type: application/json" \
  -d '{ "repo": "repo_name", "main_branch": "main_branch_name"}'
  $ curl -sS -X POST http://localhost:3000/api/token   -H "Authorization: Bearer dev-bootstrap-token"
```

### Latest report link

`GET /reports/latest` is public, like `/reports/tree`. It redirects to the newest completed report of a branch, so you can share or bookmark the link:

```text
/reports/latest?repo=repo_name                         # project main branch (falls back to MAIN_BRANCH)
/reports/latest?repo=repo_name&branch=feature-x        # specific branch
/reports/latest?repo=repo_name&plugin=awesome          # specific plugin's index.html
/reports/latest?repo=repo_name&view=charts             # open the charts view (same as appending #charts)
```

It returns `404` if the branch has no completed reports (it does not fall back to another branch) or if the report doesn't contain the requested plugin. The `/reports/tree` page shows a `latest` link next to each branch.

### Scopes API

`GET /api/scopes` is public and lists every repo/branch that has completed reports, with the latest report of each, sorted by repo and then branch. Add `?repo=repo_name` to list only one repo:

```shell
$ curl -sS http://localhost:3000/api/scopes
{"scopes":[{"repo":"service-a","branch":"main","mainBranch":"main","latestUrl":"/reports/latest?repo=service-a&branch=main","latest":{"id":"…","name":"…","completedAt":"…","url":"/…"}}]}
```

`mainBranch` is the project's main branch (falls back to `MAIN_BRANCH`). URLs are absolute when `PUBLIC_URL` is set.

### Report retention

Automated report retention can delete old reports to reduce disk or storage costs. It is disabled by default and enabled only when at least one retention env var is set:

- `REPORT_RETENTION_MAX_REPORTS_PER_BRANCH`: keep newest completed reports per branch up to this positive integer limit, delete older ones.
- `REPORT_RETENTION_MAX_REPORT_AGE_DAYS`: delete reports older than this positive number of days. The newest completed report per branch is always preserved.

Both strategies can be enabled together. Retention does not change public history download limits or manual delete behavior.

#### Stale branch retention

The options above always keep the newest report of every branch, so merged or deleted branches stay forever. To remove them:

- `REPORT_RETENTION_STALE_BRANCH_DAYS`: delete **all** reports of a branch whose newest completed report is older than this positive number of days. A branch with a draft updated within that period is skipped.
- `REPORT_RETENTION_PROTECTED_BRANCHES`: comma-separated branch names (exact match, all repos) that are never removed, e.g. `master,dev`. The project's main branch (or `MAIN_BRANCH`) is always protected.
- `REPORT_RETENTION_STALE_BRANCH_DRY_RUN`: `true` only logs what would be deleted. Try it before enabling deletion.

Stale branch retention runs in the scheduled sweep only (hourly for Docker, the cron for Cloudflare), not after report completion.
