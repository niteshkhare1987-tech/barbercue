# FastQue Meta Pixel

The Next.js App Router web app uses Meta’s manual browser Pixel. The repository audit found an existing first-party visitor counter and internal reporting, but no Meta Pixel, Google Tag Manager, or website advertising consent control. The first-party counter and booking attribution still use their existing endpoints and data.

## Configuration

Copy the advertising settings in `apps/web/.env.example` into `apps/web/.env.local` for local development, or set them on the staging web service. Set `META_PIXEL_ID` to a numeric ID for a dedicated test dataset and `META_PIXEL_ENABLED=true` to enable measurement. Until both are set, advertising measurement is off.

Use manual installation settings in Meta Events Manager. Turn off Automatic Advanced Matching, automatic event detection, and first-party Pixel cookies for this dataset. Remove any existing Event Setup Tool rules for the same events. FastQue also disables SDK automatic configuration and history tracking in code. [Meta Pixel manual installation](https://developers.facebook.com/documentation/meta-pixel/get-started) · [Meta’s Pixel template](https://github.com/meta/GoogleTagManager-WebTemplate-For-FacebookPixel/blob/main/template.tpl)

To provision an immediate stop, set `META_PIXEL_KILL_SWITCH_FILE` to an absolute path on storage accessible to each running web instance. Leave the file absent while tracking is enabled. Create the marker on each instance, or once on a shared mount, to block the next dispatch even in open tabs. Remove it to resume. The configuration endpoint is uncached and checked before each dispatch. You can also set `META_PIXEL_ENABLED=false` and apply the runtime environment change through your host. Restart or roll the web service if required by the host. Requests already sent to Meta cannot be recalled.

## Events and privacy

| Event | Trigger |
| --- | --- |
| `PageView` | An eligible pathname becomes active with advertising consent. SPA back and forward navigation count. Query-string and fragment changes do not generate extra page views. |
| `Search` | A filtered salon or service discovery request returns successfully and its results are accepted by the search page. Zero results still count. |
| `ViewContent` | A salon profile or that salon’s service list on the booking page renders after the server loads the salon successfully. |
| `InitiateCheckout` | A customer selects a slot and reaches booking review for the first time in the current booking flow. |
| `Schedule` | The booking creation API returns `CONFIRMED`. The booking ID stays in tab memory for deduplication. Failed requests and `PENDING_PAYMENT` holds do not count. |
| `Purchase` | The current site has no provider-verified payment success signal. UPI launch, QR display, a return to the site, promotional credit redemption and a shop-entered invoice status do not trigger this event. Add the event when a verified customer payment flow is available. |

The opt-in is stored in the current browser and can be changed through **Advertising choices**. A decline, withdrawal, Global Privacy Control signal, or storage failure blocks advertising measurement. Only allowlisted public discovery, informational and customer booking pages participate. The SDK runs in an opaque-origin sandbox with a fixed URL and no referrer. It receives event names only, so search text, coordinates, URL parameters, campaign tokens, booking IDs, customer data and payment details are absent. Meta can still receive browser and network metadata. Events share the frame URL in Meta and do not support per-page URL attribution. Blocked scripts, timeouts and other reporting failures are isolated from customer actions.

## Meta Events Manager → Test Events

1. On staging, enable the test dataset, then open **Events Manager → Data Sources → [test dataset] → Test Events**. Use the browser or website test option to open the staging URL. Open DevTools Network and turn on Preserve log. Use synthetic customer and booking data.
2. In a fresh browser profile, verify that no `connect.facebook.net` or Meta `/tr` request occurs before a choice. Decline and reload, then repeat with Global Privacy Control enabled. Each should remain quiet.
3. Allow advertising. Expect one `PageView`, then navigate to Search and a salon listing without reloading. Confirm one `PageView` per pathname transition, including back and forward, and a `ViewContent` on the salon and its booking service list. Change a search filter and confirm `Search` appears after a successful result response, including zero results. Force a search API error and verify no `Search`.
4. Select a booking slot and expect one `InitiateCheckout`. Complete a confirmed test booking and expect one `Schedule`. Try a failed booking and a pending-payment hold and verify neither emits `Schedule`. Open a UPI payment intent or display a QR and verify no `Purchase`.
5. Inspect the Meta network requests. The document URL should be the fixed frame URL. Check that the payload and referrer contain no parent URL or private values. Visit account, login, queue, owner and admin pages and verify no events from these routes.
6. Test withdrawal and the marker kill switch in an already-open tab. Make another eligible navigation and verify no new Meta event. Block the Meta script and repeat a normal test booking to verify FastQue still works.

## Local regression checks

```powershell
npm run typecheck --workspace=@barbercue/web
npm run test --workspace=@barbercue/web -- --runInBand --silent
```

The web regression run passed 1,208 tests. The 14 failures matched the two suites already recorded in [the web Jest baseline](owner-operations/baseline/web-jest.json). All 106 focused analytics and booking tests passed. A local headless Chrome smoke test with a stub SDK confirmed that the sandbox emits an event with its fixed frame URL and an empty referrer. Complete the staging browser test with a test dataset before enabling production measurement.
