const laptopTablet = require("./laptopTablet");
const phone = require("./phone");
const tvMonitor = require("./tvMonitor");
const appliance = require("./appliance");
const { headphonesAudio, printer, camera } = require("./audioOfficeCam");

/**
 * Every entry here is a self-contained category definition:
 *   { categoryId, classifierKeywords, fieldAliases }
 *
 * To support a new product category, add a new file under this folder in
 * the same shape and register it below — nothing else in the pipeline
 * needs to change.
 */
const CATEGORIES = [
  laptopTablet,
  phone,
  tvMonitor,
  appliance,
  headphonesAudio,
  printer,
  camera,
];

const UNKNOWN_CATEGORY = {
  categoryId: "unknown",
  classifierKeywords: [],
  fieldAliases: {},
};

module.exports = { CATEGORIES, UNKNOWN_CATEGORY };
