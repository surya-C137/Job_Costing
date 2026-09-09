# Deploy

Placeholder. Filled in by BUILD-PLAN Task 5.1:

- `docker-compose.yml` — app + Caddy for HTTPS (internal CA or self-signed) + a backup sidecar that copies `data/` nightly to `BACKUP_PATH` with 30-day rotation
- `windows/` — node service via nssm, scheduled-task backup script, restore steps
- `.env.example` — every variable documented
- `docs/RUNBOOK.md` — install, first login, restore from backup, upgrade, where logs are

Shops run either Docker or a plain Windows Server box, so both paths have to work (REQUIREMENTS §2).

The backup target is `data/` — the SQLite file and `data/attachments/` — which is deliberately gitignored. Losing it loses every quote.
