@echo off
REM ─── RW Worldview — Windows local start script ────────────────────────────
REM Copy this file, fill in your keys, and run it to start the server locally.
REM The server will be available at http://localhost:4001

REM Required: Google Maps Platform key with Map Tiles API enabled and billing on.
REM Get one at https://console.cloud.google.com/
set GOOGLE_MAPS_API_KEY=

REM Optional: Cesium Ion token — only needed for Cesium Ion-hosted assets.
set CESIUM_ACCESS_TOKEN=

REM Optional: set to true to enable OpenSky live flight ingestion.
set RW_OPENSKY_ENABLED=false

REM Default renderer view (earth is the only supported value).
set RW_DEFAULT_VIEW=earth

REM Optional: override the port (default 4001).
REM set PORT=4001

node server.js
