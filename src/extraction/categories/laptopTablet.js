module.exports = {
  categoryId: "laptop_tablet",
  // Keywords used by the classifier to recognize this category.
  classifierKeywords: [
    "նոթբուք",
    "պլանշետ",
    "laptop",
    "notebook",
    "tablet",
    "ուլտրաբուք",
    "chromebook",
  ],
  fieldAliases: {
    deviceType: ["սարքի տեսակ", "device type"],
    os: ["օպերացիոն համակարգ", "os", "operating system"],
    screenSize: ["էկրան", "display", "դյույմ", "inch"],
    resolution: ["կետայնություն", "resolution"],
    aspectRatio: ["հարաբերակցություն", "aspect ratio"],
    cpu: ["պրոցեսոր", "cpu", "processor"],
    gpu: ["տեսաքարտ", "gpu", "graphics"],
    ram: ["օպերատիվ հիշողություն", "ram"],
    storage: ["ներքին հիշողություն", "ssd", "hdd", "storage"],
    frontCamera: ["առջևի տեսախցիկ", "front camera"],
    rearCamera: ["հետևի տեսախցիկ", "rear camera", "back camera"],
    battery: ["մարտկոց", "battery"],
    keyboard: ["ստեղնաշար", "keyboard"],
    touchpad: ["touchpad"],
  },
};
