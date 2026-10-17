// One screen-pixel grid for every Sip renderer and the main process.
(function(root) {
  const constants = Object.freeze({ PX: 3, WATER_BASE_RATIO: 0.06, WATER_FULL_RATIO: 0.40 });
  if (typeof module !== 'undefined' && module.exports) module.exports = constants;
  else root.SipConstants = constants;
})(typeof window !== 'undefined' ? window : globalThis);
