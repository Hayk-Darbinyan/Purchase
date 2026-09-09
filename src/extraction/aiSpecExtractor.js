const { GoogleGenAI, Type } = require("@google/genai");
const { config } = require("../config");
const logger = require("../logger");

/**
 * Why this exists: the old pipeline (categoryClassifier + specNormalizer +
 * queryBuilder) only recognizes attributes it was hand-programmed to
 * expect, per category. This module instead asks an LLM to *read and
 * understand* the raw spec text — in whatever mix of Armenian, Russian,
 * and English it's written in — and decide for itself which details
 * actually matter for finding the product online. No fixed field list,
 * no fixed category list.
 *
 * Output contract (deliberately open-ended, but always this shape so
 * downstream code has something stable to consume):
 *   {
 *     productType: string,              // e.g. "2-in-1 detachable tablet-laptop"
 *     characteristics: [{label, value}], // however many the model finds relevant
 *     searchQuery: string,               // ready to hand to the search layer
 *   }
 */

let client = null;
function getClient() {
  if (!config.geminiApiKey) return null;
  if (!client) client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  return client;
}

function isAiExtractionAvailable() {
  return Boolean(config.geminiApiKey);
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    productType: {
      type: Type.STRING,
      description:
        "Short English phrase for what kind of product this is, e.g. " +
        "'2-in-1 detachable tablet-laptop', 'front-load washing machine'.",
    },
    characteristics: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          value: { type: Type.STRING },
        },
        required: ["label", "value"],
      },
    },
    searchQuery: {
      type: Type.STRING,
      description:
        "A single plain-language search query combining the most " +
        "identifying characteristics, suitable for a web/product search engine.",
    },
  },
  required: ["productType", "characteristics", "searchQuery"],
};

function buildPrompt(product) {
  return `You are analyzing one line item from a government procurement (tender) spec sheet.

The technical specification text may be written in Armenian, Russian, English, or a mixture of these. It may describe ANY kind of consumer electronics or appliance (phone, laptop, tablet, TV, monitor, refrigerator, washing machine, headphones, printer, camera, etc.) — do not assume a category in advance, determine it from the text itself.

Product name/label from the sheet: "${product.name || "(not given)"}"

Raw technical specification text:
"""
${product.techSpecRaw}
"""

Task: identify the concrete technical characteristics that actually matter for finding a real, currently-sold product that matches this specification — not everything mentioned. Ignore pure contractual boilerplate (warranty terms, delivery timelines, standard compliance clauses) unless it would meaningfully narrow down a product search.

Rules:
- Only include characteristics that would actually help distinguish this product from similar ones (e.g. screen size, CPU family, RAM, storage, camera resolution, capacity, connectivity standard, energy class) — skip generic or boilerplate lines.
- Do NOT invent a brand or model number that isn't stated in the text — if none is given, leave it out.
- Translate/normalize characteristic labels and values to English for consistency, but preserve exact numbers, units, and any explicit alternative options (e.g. "Snapdragon X Plus OR Intel Core Ultra 7" should stay as an alternative, not be collapsed to one).
- searchQuery should read like something a person would actually type into a search engine or store search box — concise, no labels/colons, just the descriptive terms.`;
}

/**
 * Calls Gemini to extract characteristics from one product's raw spec
 * text. Returns null (never throws) on any failure — missing API key,
 * network error, malformed response — so callers can fall back to the
 * rule-based extractor without special-casing errors.
 */
async function extractSpecWithAI(product) {
  const ai = getClient();
  if (!ai) return null;

  try {
    const response = await ai.models.generateContent({
      model: config.geminiModel,
      contents: buildPrompt(product),
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.1,
      },
    });

    const parsed = JSON.parse(response.text);
    if (
      !parsed ||
      !Array.isArray(parsed.characteristics) ||
      typeof parsed.searchQuery !== "string"
    ) {
      logger.warn("Gemini extraction returned an unexpected shape", {
        name: product.name,
      });
      return null;
    }

    logger.info("AI spec extraction succeeded", {
      name: product.name,
      productType: parsed.productType,
      characteristicCount: parsed.characteristics.length,
    });

    return parsed;
  } catch (err) {
    logger.warn("Gemini extraction failed, will fall back to rule-based extraction", {
      name: product.name,
      error: err.message,
    });
    return null;
  }
}

module.exports = { extractSpecWithAI, isAiExtractionAvailable };
