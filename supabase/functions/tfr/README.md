# `tfr` — live TFR proxy

Serves **all active FAA Temporary Flight Restrictions** (wildfire, VIP/Presidential, sporting,
security) for a region as CORS-enabled GeoJSON, so the static SkyLab page can draw them. It proxies
`tfr.faa.gov` (no CORS, geometry only as per-NOTAM AIXM XML) and parses the boundaries server-side.

The web app calls it automatically; if it isn't deployed it silently falls back to the FAA ArcGIS
security-TFR layer.

## Deploy

You need the Supabase CLI. No global install required — use `npx`:

```bash
# one-time login (opens a browser)
npx supabase login

# deploy the function PUBLICLY (no JWT) so the static page can call it
npx supabase functions deploy tfr --no-verify-jwt --project-ref zfzayopcdswmkwgugyqp
```

`--no-verify-jwt` is required: the page calls the function without a user login.

## Test

```bash
curl "https://zfzayopcdswmkwgugyqp.supabase.co/functions/v1/tfr?states=UT,ID,WY,NV,AZ,CO,NM"
```

You should get `{"type":"FeatureCollection","features":[...]}`. Use `?states=ALL` for the whole US.

## Notes

- Results are cached in-memory for 10 min per `states` value to avoid hammering the FAA.
- Capped at 80 TFRs per request to stay under the function timeout.
- Geometry parsing covers polygons and circles; exotic arc boundaries may be approximated. The
  popup links to `tfr.faa.gov` for the authoritative detail.
