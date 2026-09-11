# Sanhe messenger bot

## Scope
- App port **3000**. Never touch Hermes gateway **8646** or its tunnel.
- Prefer DEMO webform (URL button → `/form?t=…` → summary back to Messenger) over long in-chat questionnaires.
- Write `customer_leads` only after user confirm/submit. No service-role key ⇒ skip DB, still return summary.

## Working style
- Small copy/UI tweaks: just edit. Large features: shortest working path first.
- Do not invent webhook/tunnel success; verify with logs (`/tmp/sanhe-webhook.log`) or curl.
- Redact tokens/secrets in chat output.

## Layout
- `src/server.js` webhook + form routes; `src/meta.js` Send API; `src/form-*.js` token/schema/page.
- Config: `.env` (local); questions JSON under `config/` when not in webform demo mode.
