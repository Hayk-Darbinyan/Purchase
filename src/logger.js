const winston = require("winston");
const { config } = require("./config");

winston.addColors({
  info: "green",
  warn: "yellow",
  error: "red",
  debug: "magenta",
});

const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length
        ? " " + JSON.stringify(meta)
        : "";
      return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

module.exports = logger;
