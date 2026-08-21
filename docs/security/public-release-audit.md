# Public Release Security Audit

This document is the release gate for changing `wiki-agent` from a private
repository to a public repository. A round is valid only when it records the
exact commit, scanner version, scope, findings, and disposition.

Do not copy secrets, personal data, or confidential company details into this
document. Findings must use categories and file paths only.

## Release rule

The repository must remain private until all mandatory checks in Rounds 1–4
pass. A failed mandatory check returns the release state to `blocked`.

Accepted risk:

- The repository owner has explicitly accepted publishing the existing commit
  author email. The address is intentionally not repeated here.

Private recovery artifacts:

- Any pre-rewrite Git bundle contains the original sensitive history.
- Bundles, mirror clones, scanner reports, and local deny lists must remain
  outside the repository and must never be attached to a GitHub issue, release,
  workflow artifact, or pull request.

## Scope

Each audit covers:

1. The current tracked tree and untracked files proposed for commit.
2. Every reachable branch and tag.
3. Deleted files still reachable through Git history.
4. Ignore boundaries for `.env`, `notes/`, `models/`, and `var/`.
5. Credentials, private keys, absolute workstation paths, personal data,
   financial data, employment data, and non-public company information.
6. Build, test, evaluation, documentation, and license consistency.
7. GitHub resources outside Git: issues, pull requests, discussions, releases,
   and Actions artifacts.

## Required evidence

Record these values for every round:

```text
Date:
Audited commit:
Compared remote commit:
Repository state:
Scanner and version:
Tracked-tree scan:
All-history scan:
Sensitive-path reachability:
Ignored-path verification:
Build and tests:
Evaluation:
GitHub non-Git resources:
Result: pass | blocked
Open findings:
```

## Repeatable checks

### Repository state

```powershell
git status --short
git rev-parse HEAD
git rev-parse origin/master
git branch --all
git tag --list
```

### Sensitive paths must remain untracked

```powershell
git ls-files ".env" ".env.*" "notes/**" "models/**" "var/**"
git check-ignore -v .env notes models var
```

Expected result: only `.env.example` may be tracked. The private paths must be
covered by `.gitignore`.

### Generic tracked-tree scan

Search tracked content for:

- private-key headers and common token prefixes;
- password, secret, and API-key assignments with non-placeholder values;
- absolute user-profile or workstation paths;
- personal finance, compensation, interview, family, and identity facts;
- company meeting notes, internal metrics, headcount, customer data, and
  proprietary project names.

Place repository-specific search terms in a local untracked deny list. Never
commit the deny list if the terms themselves disclose private information.

### Full-history scan

Install and record the version of Gitleaks, then scan all reachable history:

```powershell
gitleaks git . --log-opts="--all"
```

Also verify that every path listed in the rewrite manifest is absent from all
historical commits:

```powershell
git log --all --oneline -- <removed-path>
git rev-list --objects --all
```

The first command must return no commits for each removed path. Review the
object list for unexpected private paths.

### Build and deterministic tests

```powershell
npm ci
npm test
npm run check:config
npm run check:knowledge-catalog
```

Paid Agent evaluation is not part of an automatic audit. Run preflight first,
then explicitly approve any paid E2E evaluation.

## Audit rounds

### Round 0 — Baseline

```text
Date: 2026-08-21
Audited commit: 7fb04b6149c4708bf0cf242a01285c9bd3d749d3
Compared remote commit: 7fb04b6149c4708bf0cf242a01285c9bd3d749d3
Repository state: clean
Scanner and version: manual inspection + Gitleaks 8.30.1
Tracked-tree scan: blocked
All-history scan: credential scan passed (81 commits, no leaks); privacy scan blocked
Sensitive-path reachability: blocked
Ignored-path verification: pass
Build and tests: previously passed; 271/271 tests
Evaluation: existing aggregate results available, but the question sets contain private facts
GitHub non-Git resources: not inspected; repository is private and GitHub CLI is unavailable
Result: blocked
```

Findings:

- No high-confidence API key, token, password, or private key was found in the
  tracked tree or 81 reachable commits.
- Gitleaks 8.30.1 scanned all 81 reachable commits and reported no leaks.
- The local `.env` contains a credential, but `.env` is ignored, untracked, and
  was not found in reachable history.
- Tracked evaluation data contains personal finance, employment, family, and
  potentially non-public company facts.
- The maintained Wiki contains private source paths and personal decisions.
- Deleted example notes remain recoverable from Git history.
- The existing commit author email is an explicitly accepted publication risk.

Disposition:

- Replace sensitive evaluation, Wiki, configuration, and documentation content
  with synthetic or public-domain fixtures.
- Remove the sensitive paths from every historical commit with
  `git-filter-repo`.
- Repeat this audit against the rewritten repository and independent clones.

### Rewrite manifest

The following historical paths are removed from every commit. Sanitized current
versions are restored only after the rewrite:

```text
evaluation/questions.json
evaluation/holdout/questions.json
evaluation/e2e/questions.json
wiki/concepts/投资体系.md
wiki/index.md
wiki/log.md
config/evaluation/raw-only.sources.jsonc
config/evaluation/raw-wiki.sources.jsonc
docs/wiki-agent-project-reference.md
docs/wiki-agent-system-guide.md
docs/evaluation/SUMMARY.md
notes/agent-rag.md
notes/markdown-notes.md
```

The old root README contains one private-corpus numeric example. Rewrite only
that exact example with a neutral latency value; do not apply broad text
replacement to technical terms.

### Round 1 — Sanitized working tree

Status: pending.

Pass criteria:

- no real personal or company facts remain in tracked evaluation fixtures;
- no private source directory appears in tracked Wiki or configuration;
- build, tests, configuration checks, and public evaluations pass;
- a second tracked-tree review finds no mandatory issue.

### Round 2 — Rewritten local history

Status: pending.

Pass criteria:

- Gitleaks reports no unreviewed finding across `--all`;
- every rewrite-manifest path is absent from historical commits;
- deleted private notes cannot be recovered from reachable objects;
- the sanitized files exist only in the final public-release commit;
- repository topology and engineering history remain reviewable.

### Round 3 — Independent local clone

Status: pending.

Pass criteria:

- a fresh clone independently passes the Round 2 checks;
- `npm ci`, `npm test`, configuration checks, and public evaluation pass;
- no recovery bundle or local deny list exists inside the clone.

### Round 4 — Fresh private GitHub clone

Status: pending.

Pass criteria:

- the force-with-lease update was explicitly approved;
- a fresh clone from GitHub passes Rounds 2 and 3;
- issues, pull requests, discussions, releases, and Actions artifacts contain no
  private material;
- anonymous public-page verification is performed only after all prior checks
  pass.

## Final publication checklist

- [ ] Rounds 1–4 are recorded as `pass`.
- [ ] The private recovery bundle is stored outside any synchronized public
      directory.
- [ ] Old clones are treated as sensitive and are not pushed.
- [ ] README links, CI, evaluation summary, and MIT license are valid.
- [ ] GitHub description contains no private project or company terminology.
- [ ] Repository visibility remains private until the final explicit decision.
