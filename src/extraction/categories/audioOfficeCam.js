module.exports = {
  headphonesAudio: {
    categoryId: "headphones_audio",
    classifierKeywords: [
      "ականջակալ",
      "բարձրախոս",
      "headphone",
      "earbud",
      "speaker",
      "soundbar",
    ],
    fieldAliases: {
      driverSize: ["դինամիկ", "driver size", "mm"],
      connectionType: ["միացման տեսակ", "wired", "wireless", "bluetooth"],
      noiseCancel: ["աղմուկի մեկուսացում", "anc", "noise cancel"],
      batteryLife: ["մարտկոցի ինքնավարություն", "battery life"],
      impedance: ["դիմադրություն", "impedance", "ohm"],
    },
  },
  printer: {
    categoryId: "printer",
    classifierKeywords: ["տպիչ", "printer", "mfp", "բազմաֆունկցիոն"],
    fieldAliases: {
      printType: ["տպման տեսակ", "laser", "inkjet", "print type"],
      printSpeed: ["տպման արագություն", "ppm", "print speed"],
      resolution: ["տպման որակ", "dpi", "resolution"],
      functions: ["ֆունկցիա", "scan", "copy", "fax", "function"],
      connectivity: ["միացում", "usb", "wi-fi", "lan"],
    },
  },
  camera: {
    categoryId: "camera",
    classifierKeywords: ["ֆոտոխցիկ", "տեսախցիկ", "camera", "dslr", "gopro"],
    fieldAliases: {
      sensor: ["սենսոր", "sensor", "megapixel", "mp"],
      lens: ["ոսպնյակ", "lens"],
      videoResolution: ["վիդեո", "video resolution", "4k"],
      stabilization: ["կայունացում", "stabilization", "ois"],
      storageMedia: ["հիշողության քարտ", "sd card", "memory card"],
    },
  },
};
