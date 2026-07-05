'use strict';

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hasLatLng(entity) {
  return Boolean(entity && Number.isFinite(entity.lat) && Number.isFinite(entity.lng));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function latLngToGrid(lat, lng) {
  const safeLat = clamp(Number(lat), -90, 90);
  const safeLng = clamp(Number(lng), -180, 180);
  return {
    x: ((safeLng + 180) / 360) * 100,
    y: ((90 - safeLat) / 180) * 100,
  };
}

function getGlobeUnitVectorFromLatLng(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const latRad = Math.max(-90, Math.min(90, lat)) * (Math.PI / 180);
  const lngRad = Math.max(-180, Math.min(180, lng)) * (Math.PI / 180);
  const cosLat = Math.cos(latRad);
  const x = cosLat * Math.sin(lngRad);
  const y = Math.sin(latRad);
  const z = cosLat * Math.cos(lngRad);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function normalizeEntityGridPosition(entity) {
  if (!entity) return;
  if (!hasLatLng(entity)) return;
  const point = latLngToGrid(entity.lat, entity.lng);
  entity.x = point.x;
  entity.y = point.y;
}

module.exports = {
  safeNumber,
  hasLatLng,
  latLngToGrid,
  getGlobeUnitVectorFromLatLng,
  normalizeEntityGridPosition,
};
