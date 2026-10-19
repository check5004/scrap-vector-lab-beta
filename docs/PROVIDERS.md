# Mode A providers

Mode A supports two explicit destinations. Selecting a provider never switches automatically to another provider or model. API calls require the user's own key and the single explicit Analyze action beside the photo/paid-usage disclosure. Expert standalone API controls retain their separate consent checkbox.

| Provider | Exact requested model | Inference endpoint |
| --- | --- | --- |
| OpenRouter | `openai/gpt-6-luna` | `POST https://openrouter.ai/api/v1/chat/completions` |
| OpenAI | `gpt-6-luna` | `POST https://api.openai.com/v1/responses` |

## Preflight and routing

- OpenRouter first authenticates with `GET https://openrouter.ai/api/v1/key`. This is a metadata request, not a model generation. The current official endpoint is `/key`.
- It then reads the public `GET https://openrouter.ai/api/v1/models` catalog without transmitting the key. The exact model must be present and advertise image input, `response_format`, and `structured_outputs`.
- The OpenRouter request uses a text part followed by an `image_url` part containing a JPEG data URL. Its `response_format` is `json_schema` with `strict: true`, and `provider.require_parameters` is `true` so unsupported endpoints are excluded. No fallback model list or alternate model is provided.
- OpenAI retains its authenticated exact-model lookup and Responses API call with `store: false` and strict JSON-schema output.
- Catalog presence is not a guarantee of an individual account's entitlement, available credits, endpoint health, or geometric measurement accuracy. Preflight does not generate an image inference; pressing Run still makes a potentially billable inference request.

## Key handling and safety

`validateProviderKey(provider, key)` checks the key locally and returns a safe message or `null`. OpenRouter requires the currently documented `sk-or-v1-` prefix; OpenAI rejects `sk-or-` keys. Changing provider restores only the selected provider's validated saved key and invalidates any in-flight captured authorization. These checks stop a wrong-provider key before any request; they do not establish that a key is valid.

The API provider layer only holds key material in function-local memory. A separate UI key store persists user-entered keys in this browser at the user's explicit request. Keys are never put in exports, diagnostic reports, URLs, analytics, logs or sessionStorage. Authenticated fetches use the selected provider's fixed endpoints, omit cookies and referrers, and reject redirects. No arbitrary endpoint configuration is supported. This browser BYOK proof of concept remains appropriate only on a trusted page/device; production should use a secure authenticated backend.

### Browser-local persistence

- Validly formatted input is automatically saved, trimmed, in versioned records under app-specific names, separately for OpenRouter and OpenAI. Reload restores OpenRouter by default; switching to OpenAI restores only its own key. Saving/restoring does not make a network request or remember photo/paid-usage consent.
- The input remains `type=password`. The selected provider's delete button removes its record and clears the input and consent. It does not delete the other provider's key. Another open app tab observes changes/removals and resets its consent and request. Page exit clears the live input; the saved record intentionally remains.
- Record shape, version, provider, key format and length are checked before restoration. Invalid records are discarded. Invalid or empty replacement input removes the previous saved value. No legacy or other application's storage entries are imported.
- Access, read, write and deletion failures are caught without echoing raw exceptions. A failed save falls back to tab-only use after trying to remove the previous saved value. A failed deletion clears the live input, suppresses that provider's restoration in this tab, and warns that the user must clear browser site data; a reload may otherwise restore the old value. No success is claimed for an unconfirmed deletion.
- localStorage is **not encrypted**. Scripts on the same origin, browser extensions, and someone with access to the browser profile can potentially read it. GitHub Pages projects under `check5004.github.io` share an origin; path-specific namespaces prevent accidental collisions, not access by another page on that origin. Use a trusted personal device, not a shared device. No application-owned credential is embedded in source or deployment.
- Storage is scoped to this browser profile and origin, and the app does not sync it across devices. Private-browsing exit, site-data deletion or browser policy can clear/block it. The UI displays the storage result next to the key input.
- Tests use unmistakably synthetic keys and intercepted requests. They cover reload, provider isolation, explicit deletion, wrong-prefix and malformed storage, unavailable/throwing storage, cross-tab deletion, canceled requests and leakage checks. They do not use or demonstrate a real authenticated API call.

Browser behavior references checked 2026-10-16: [Mozilla localStorage documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage), [Mozilla storage event documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/storage_event).

OpenRouter receives the photograph and board dimensions and routes the request to its model provider. Their data policies apply. `store: false` on direct OpenAI requests is not a guarantee of zero retention.

## Errors, cancellation and output

`ProviderError` exposes only `provider`, `stage`, `endpoint`, `status`, `code`, and a safe local message. It never includes raw provider messages/bodies, request headers, image bytes, or a raw exception cause. An HTTP 200 response containing an error envelope is an error; its HTTP status stays 200 and any recognized numeric API error is distinguished in `code`.

401 indicates authentication was rejected, but does not by itself identify a particular cause. Check provider/key pairing, missing/invalid credentials, revocation, or expiry. Other statuses have separate guidance: credits/limits (402), permissions/policy/budgets (403), model/endpoint availability (404), rate limits (429), or service failures (5xx). No automatic retry is performed because a failed-looking inference may already have been charged.

An `AbortSignal` stops preflight or an in-flight request. The code checks cancellation before image serialization and immediately before POST, and ignores late success after cancellation. Aborting cannot undo data already transmitted or charges already incurred. Local segmentation also accepts the signal and terminates its worker on abort, timeout, success, or failure.

Responses must report the requested Luna model (or a dated snapshot of it), complete normally, contain valid JSON, match the exact shape structure, and pass finite-coordinate, topology, hole containment, complexity, and board-bound checks. Missing, refused, incomplete, malformed, or different-model results fail closed. No substitute coordinates are created.

## Implementation contract

- `inferLunaProvider(provider, key, image, board, progress, signal?)` returns `{ geometry, model, requestId, provider }`.
- `inferLuna(...)` is a backwards-compatible OpenAI wrapper.
- `progress` receives human-readable strings only; it never receives keys or provider bodies.
- `segment(source, progress, signal?)` retains its prior result and forwards optional worker timings.
- Unit tests in `tests/ai.test.ts` replace fetch and workers explicitly. They make no actual API request, use no real key, and do not demonstrate authenticated/paid-inference success.

## Official references checked 2026-10-15

- [OpenRouter current-key metadata endpoint](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)
- [OpenRouter chat completion endpoint](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion)
- [OpenRouter image-input guide](https://openrouter.ai/blog/tutorials/send-image-to-llm/)
- [OpenRouter structured outputs and required-parameter routing](https://openrouter.ai/docs/guides/features/structured-outputs)
- [OpenRouter live model catalog](https://openrouter.ai/api/v1/models), listing exact `openai/gpt-6-luna` and image/structured-output support when checked
- [OpenRouter key creation reference](https://openrouter.ai/docs/api/api-reference/api-keys/create-keys) and [OAuth key response](https://openrouter.ai/docs/api/api-reference/o-auth/exchange-auth-code-for-api-key), documenting the current key prefix
- [OpenRouter authentication](https://openrouter.ai/docs/api_reference/authentication) and [error handling](https://openrouter.ai/docs/api_reference/errors-and-debugging)


## Beta candidate review

The `0.3.0-dev.3` beta offers an optional candidate-review loop, off by default. It sends the rectified photograph and actual mask/polygon overlays only when the user enables that setting beside method selection and presses Analyze (or explicitly uses its expert standalone start), uses the selected provider, and is capped at 1–3 calls. Tokens and provider-reported costs are shown; missing costs stay unknown. See [the beta contract](BETA_RELEASE.md). Beta keys use `scrap-vector-lab-beta:provider-key:v1:*`; production key names are not read or migrated. GitHub Pages project paths still share an origin, so this avoids collisions rather than creating a security boundary.
