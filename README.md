# Readable-Writable
Readable Writable agent

## OpenSky live flight ingestion

The RW Worldview server can add OpenSky live flights as an additive layer (without replacing simulation agents).

### Environment variables

- `RW_OPENSKY_ENABLED=true` to enable polling.
- `OPENSKY_CLIENT_ID=<oauth-client-id>` OpenSky OAuth2 client id.
- `OPENSKY_CLIENT_SECRET=<oauth-client-secret>` OpenSky OAuth2 client secret.
- `RW_OPENSKY_POLL_INTERVAL_MS=15000` optional poll interval (minimum enforced: 5000 ms).
- `OPENSKY_TOKEN_URL` optional override for OAuth token endpoint.
- `OPENSKY_STATES_URL` optional override for OpenSky states endpoint.
