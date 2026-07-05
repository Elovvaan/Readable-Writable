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
  const phi = lat * Math.PI / 180;
  const theta = lng * Math.PI / 180;
  const cosPhi = Math.cos(phi);
  return {
    x: cosPhi * Math.cos(theta),
    y: Math.sin(phi),
    z: cosPhi * Math.sin(theta),
  };
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
