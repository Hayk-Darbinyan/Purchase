/**
 * @typedef {Object} MarketListing
 * @property {string} title
 * @property {string} url
 * @property {string} content    - snippet/body text used for verification
 * @property {string} [store]    - display name, derived from domain if absent
 * @property {string} [price]    - raw price string, if the source exposes one
 */

/**
 * Base class for a pluggable market search backend. Implementations must
 * never fabricate results: return an empty array when nothing was found.
 */
class MarketSource {
  /**
   * @param {string} query
   * @param {{ domains?: string[] }} [options]
   * @returns {Promise<MarketListing[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async search(query, options = {}) {
    throw new Error("MarketSource.search must be implemented by a subclass");
  }
}

module.exports = { MarketSource };
