// Canonical-field aliases that can appear on almost any electronics/appliance
// spec sheet, regardless of category. Matching is substring-based on the
// lowercased Armenian (or English) label text.
module.exports = {
  brand: ["ապրանքային նշան", "ֆիրմային անվանում", "brand"],
  model: ["մոդել", "model"],
  warranty: ["երաշխ", "warranty"],
  weight: ["քաշ", "weight"],
  dimensions: ["չափս", "բարակություն", "dimensions", "size"],
  color: ["գույն", "color", "colour"],
  countryOfOrigin: ["ծագման երկիր", "արտադրող երկիր", "made in"],
  connectivity: [
    "կապի հնարավորություն",
    "wi-fi",
    "wifi",
    "bluetooth",
    "usb",
    "connectivity",
  ],
  power: ["հզորություն", "power", "watt", "վտ"],
};
