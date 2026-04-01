# Readable-Writable
Readable Writable agent

## RW/ARW Worldview Cesium Earth rendering

The worldview frontend now supports a single CesiumJS Earth view with Google Maps Platform Photorealistic 3D Tiles as the base layer. Existing snapshot/event APIs and the single Node server architecture remain unchanged.

### Required / recommended environment variables

- Cesium + Google Maps Platform 3D Tiles is now the only supported renderer.
- `RW_DEFAULT_VIEW=earth` keeps the Earth view as the default mode.
- `GOOGLE_MAPS_API_KEY=<google-maps-platform-key>` required for Google Photorealistic 3D Tiles (`tile.googleapis.com`).
- `CESIUM_ACCESS_TOKEN=<token>` optional; only needed if you use Cesium Ion-hosted features.

### Google Maps Platform setup

1. Create/select a Google Cloud project.
2. Enable billing on that project.
3. Enable the Map Tiles API and ensure 3D tiles access is allowed for your key.
4. Restrict the API key appropriately for deployment origins.
5. Set `GOOGLE_MAPS_API_KEY` in your runtime environment.

### Local run

```bash
npm install
RW_DEFAULT_VIEW=earth GOOGLE_MAPS_API_KEY=your_key npm start
```

## OpenSky live flight ingestion

The RW Worldview server can add OpenSky live flights as an additive layer (without replacing simulation agents).

### Environment variables

- `RW_OPENSKY_ENABLED=true` to enable polling.
- `RW_OPENSKY_POLL_INTERVAL_MS=15000` optional poll interval (minimum enforced: 5000 ms).
- `RW_OPENSKY_GLOBE_MIN_Z=-1` optional OpenSky globe visibility threshold used for ingestion diagnostics.
- `OPENSKY_STATES_URL` optional override for OpenSky states endpoint.
