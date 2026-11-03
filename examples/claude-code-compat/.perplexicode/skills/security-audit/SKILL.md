---
name: security-audit
description: Checklist for auditing a change for injection, secrets, authz and unsafe shell use.
---
# Security audit

1. Inputs: every value that reaches SQL, shell, file paths, HTML or URLs is validated or escaped.
2. Secrets: no tokens, keys or cookies in code, logs, test fixtures or command-line arguments.
3. AuthZ: each new endpoint or command checks the caller's permission, not only authentication.
4. Shell: no `sh -c` with interpolated user input; prefer argument arrays.
5. Dependencies: new packages are pinned and come from the expected registry.
Report each finding as: severity, file:line, impact, fix.
