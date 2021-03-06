const config = require('config');
const moment = require('moment')
const serverConfig = config.get('server');
const logger = require('./logger.js')

function logRequest(body, type)
{
    if (serverConfig.logRequests)
    {
        logger.debug("REQUEST: " + type + ":\n" + JSON.stringify(body,null,2))
    }
}

function logQuery(query, options)
{
    if (serverConfig.logQueries)
    {
        logger.debug("Query:")
        logger.debug(JSON.stringify(query,null,2))
        if ( options != null )
        {
            logger.debug("Query Options:")
            logger.debug(JSON.stringify(options,null,2))
        }
    }
}

function logTiming(body, elapsedTimeMs)
{
    if (serverConfig.logTimings)
    {
        const range = new Date(body.range.to) - new Date(body.range.from)
        const diff = moment.duration(range)

        logger.debug("Request: " + intervalCount(diff, body.interval, body.intervalMs) + " - Returned in " + elapsedTimeMs.toFixed(2) + "ms")
    }
}

// Take a range as a moment.duration and a grafana interval like 30s, 1m etc
// And return the number of intervals that represents
function intervalCount(range, intervalString, intervalMs)
{
    // Convert everything to seconds
    const rangeSeconds = range.asSeconds()
    const intervalsInRange = rangeSeconds / (intervalMs / 1000)

    return intervalsInRange.toFixed(0) + ' ' + intervalString + ' intervals'
}

module.exports = {
    logQuery,
    logRequest,
    logTiming
}