const winston = require('winston');
const logLevel = process.env.LOG_LEVEL || "info"

const logFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.align(),
    winston.format.printf(  info => `${info.timestamp} ${info.level}: ${info.message}`,),
    );

const logger = winston.createLogger({
    level: logLevel,
    format: winston.format.json(),
    defaultMeta: { service: 'mongo-grafana' },
    transports: [],
});

//
// If we're not in production then log to the `console` with the format:
// `${info.level}: ${info.message} JSON.stringify({ ...rest }) `
//
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: logFormat
    }));
} else {
    logger.add(new winston.transports.Console());
}

module.exports = logger;