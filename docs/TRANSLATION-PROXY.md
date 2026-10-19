# Automatic translation: design, cost and activation

Reviewed 2026-10-19 (Asia/Shanghai). **The proxy implementation is tested with simulated provider responses. It is not activated or live-provider verified yet.** This environment has no Cloudflare account binding or translation credentials. The reader clearly reports this; manual translation/import and both reading modes remain available. No subscription or paid infrastructure has been enabled.

## Provider decision

| Option | Evidence and trade-off | Decision |
| --- | --- | --- |
| DeepL API Free | Official SDK documents 500,000 characters/month free. The API accepts English → Simplified Chinese, and returns one translation per input text in the same order. Each input is translated independently, so context and specialist terminology can suffer. | Built-in provider, via a free-only server-side proxy. Use `api-free.deepl.com`, `ZH-HANS`, and `split_sentences=0`. Imported sentences remain unreviewed. |
| Cloudflare Workers + SQLite Durable Object + Turnstile | Workers Free has a 100,000-request daily limit; free-tier excess fails rather than transparently upgrading. Durable Objects provide atomic quotas shared across requests; Turnstile limits automated abuse. | One small Worker, one quota object, no models, SDK, translation database or paid plan. Browser caches results. |
| Self-hosted translation models | Requires model storage and ongoing compute/operations, with substantial language-quality differences. | Not introduced. |
| Unofficial public translation endpoints | Undocumented quotas, availability, retention and access conditions; potentially unstable interfaces. | Not used as a supposedly reliable default. |

Sources: [DeepL official SDK](https://github.com/DeepLcom/deepl-node#authentication), [official OpenAPI specification](https://github.com/DeepLcom/openapi/blob/main/openapi.yaml), [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/). Documentation was read from the providers' GitHub documentation repositories where the cloud proxy blocked their main sites. Free-account eligibility and terms must be checked when registering; no live translation quality benchmark is claimed.

## Cost and privacy boundaries

- DeepL API Free permits **500,000 characters/month** under its documented free allowance. This integration rejects Pro keys and cannot select a paid DeepL endpoint. If the account or regional signup requires a paid subscription, stop; this project does not authorize one.
- Conservative default proxy caps: **100,000 characters/month total**, **50,000/day total**, **20,000/day per IP hash**. Each batch is at most 4,000 Unicode code points and 50 source sentences. The browser defaults to a **20,000-uncached-character job limit**, checked across the whole job before any text is sent. These are separate source-character and provider-attempt budgets.
- Each upstream attempt reserves quota atomically, including failed/uncertain attempts. Up to two retries on 429/502/503/504 use exponential backoff. This may over-count actual provider billing, deliberately preventing an outage from spending beyond the safety budget. A 10,000-character paper can reserve up to 30,000 characters if every batch takes three attempts, and stop at the daily cap. No automatic client retry hides another provider charge.
- Already translated source IDs are skipped, preserving manual corrections. Browser cache keys include source text, language pair and endpoint. Re-running a partial job reuses cached one-to-one results and skips completed translations. Cache survives only when local persistence is enabled; JSON export omits the disposable cache.
- Only text and sentence IDs leave the browser after consent. No PDF bytes, paper filename, fingerprint, notes or cookies are sent. DeepL and Cloudflare necessarily process submitted text. “PDF stays local” does not mean its text stays local after consenting to translation.
- Turnstile is loaded **only after consent**, and its challenge must match the reader hostname and action. Turnstile/Cloudflare also process connection/browser information. No provider credential is accepted by the frontend.
- Server responses use `Cache-Control: no-store`; source text and translations are not stored by this Worker. Its one Durable Object stores current quota counters and salted IP hashes, resetting the hash map daily. This describes our implementation, not a guarantee about provider/platform retention policies. Worker observability is disabled; do not add request-body logging.
- CORS alone is not authentication. Origin checks, validated one-use Turnstile challenges, a per-IP quota and an atomic global quota bound public-proxy exposure. A determined human can still use a public proxy and consume its shared free allowance. Use an authenticated private gateway if that threat matters; this release does not pretend Turnstile identifies the owner.

## Activate without a local installation

These are account configuration steps, not a request to paste credentials into chat. The implementation, tests and workflow are ready for review before activation.

1. Use an existing **Cloudflare Workers Free** account and **DeepL API Free** account. Create a scoped Cloudflare API token with Workers Scripts edit permissions for only that account. Do not upgrade either plan. Review the providers' current terms and text handling for the papers you intend to translate.
2. In Cloudflare, create a free managed Turnstile widget for `fleetsnowfluff-ann.github.io`. Keep its secret private; its site key is public. Enable the account's free `workers.dev` subdomain.
3. In GitHub repository Settings → Secrets and variables → Actions, add **secrets** `CLOUDFLARE_API_TOKEN`, `DEEPL_API_KEY`, `TURNSTILE_SECRET`. Add the nonsecret **variable** `CLOUDFLARE_ACCOUNT_ID`. You may instead scope them to the `translation-proxy` environment.
4. Run **Deploy free translation proxy** on `main`, confirming that the account is on the free plan. This manually dispatched workflow uses Cloudflare's API from a GitHub runner; it installs no CLI and never changes billing. It provisions one SQLite quota Durable Object and uploads the provider secrets directly to the Worker. Subsequent deployments preserve quota state.
5. Copy the resulting `/translate` URL into the public GitHub repository variable `TRANSLATION_ENDPOINT`. Add public variable `TURNSTILE_SITE_KEY`. **Neither value is a provider/API secret.** Run **Deploy reader to GitHub Pages**. The build requires both variables together and embeds only these public values.
6. On the live reader, open the sample, choose Translation, inspect the endpoint, and grant consent. Translate one page, verify the Chinese and its source links, then test the paper queue. No live-provider smoke test can legitimately be run before these credentials exist and the user consents to sending text.

The static deployment remains independent of proxy deployment. Remove the two public variables and redeploy Pages to disconnect the built-in service; no annotations or translations are deleted. A trusted custom adapter remains supported via the endpoint field. `worker/wrangler.jsonc` is the documented configuration; a GitHub-only deployment script submits the same bindings without requiring Wrangler.

## Verification and limitations

Unit tests exercise input caps, origin rejection, missing credentials, paid-key rejection, challenge validation, exact input/output cardinality, bounded retries, concurrent quota reservations and lack of credentials in responses. These tests model Workers APIs in Node; they do not claim a deployed Cloudflare integration test.

Provider order is a documented transport contract, not proof of semantic equivalence. Long extracted “sentences”, technical notation, page-boundary fragments and text extraction errors still need review. Unreliable mappings/rotated or unresolved source text are skipped, with an explicit count. The unchanged original remains authoritative. No universal alignment or translation-accuracy score is claimed.
