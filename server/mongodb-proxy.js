const express = require('express');
const bodyParser = require('body-parser');
const _ = require('lodash');
const app = express();
const MongoClient = require('mongodb').MongoClient;
const assert = require('assert');
const config = require('config');
const logs = require('./logs.js');
const Stopwatch = require("statman-stopwatch");
const auth = require('./auth');
const rateLimit = require("express-rate-limit");

app.use(bodyParser.json());
// Get config from server/default.json
const serverConfig = config.get('server');
const rateLimitWindowMinutes = process.env.RATE_LIMIT_MINUTES || 1
const rateLimitMax = process.env.RATE_LIMIT_MINUTES || 10
const baseUrl = process.env.BASE_URL || "mongo-grafana-service"
const limiter = rateLimit({
  windowMs: rateLimitWindowMinutes * 60 * 1000, // 1 minutes
  max: rateLimitMax // limit each IP to 100 requests per windowMs
});
app.use(limiter);

app.listen(serverConfig.port);

console.log("Server is listening on port " + serverConfig.port);
const mongodb_url = process.env.MONGODB_URL || null;

// Called by health check logic
app.get(`/internal.api/v1/${baseUrl}/settings/health`, function (req,res){
  res.sendStatus(200);
})

app.all(`/api/v1/${baseUrl}/`, auth, function(req, res, next)
{
  logs.logRequest(req.body, "/")
  setCORSHeaders(res);

  MongoClient.connect(getMongoURL(req), function(err, client)
  {
    if ( err != null )
    {
      res.send({ status : "error",
        display_status : "Error",
        message : 'MongoDB Connection Error: ' + err.message });
    }
    else
    {
      res.send( { status : "success",
        display_status : "Success",
        message : 'MongoDB Connection test OK' });
    }
    next()
  })
});

// Called by template functions and to look up variables
app.all(`/api/v1/${baseUrl}/search`, auth, function(req, res, next)
{
  logs.logRequest(req.body, "/search")
  setCORSHeaders(res);

  let db = {
    url: getMongoURL(req),
    db: req.body.db.dbName
  }

  // Generate an id to track requests
  const requestId = ++requestIdCounter                 
  // Add state for the queries in this request
  let queryStates = []
  requestsPending[requestId] = queryStates
  // Parse query string in target
  let queryArgs = parseQuery(req.body.target, {})
  if (queryArgs.err != null)
  {
    queryError(requestId, queryArgs.err, next)
  }
  else
  {
    doTemplateQuery(requestId, queryArgs, db, res, next);
  }
});

// Called to get graph points
app.all(`/api/v1/${baseUrl}/query`, auth, function(req, res, next)
    {
      logs.logRequest(req.body, "/query")
      setCORSHeaders(res);
      let db = {
        url: getMongoURL(req),
        db: req.body.db.dbName
      }

      // Parse query string in target
      let substitutions = {
        "$from": new Date(req.body.range.from),
        "$to": new Date(req.body.range.to),
        "$dateBucketCount": getBucketCount(req.body.range.from, req.body.range.to, req.body.intervalMs)
      }

      // Generate an id to track requests
      const requestId = ++requestIdCounter
      // Add state for the queries in this request
      let queryStates = []
      requestsPending[requestId] = queryStates
      let error = false

      for (let queryId = 0; queryId < req.body.targets.length && !error; queryId++)
      {
        tg = req.body.targets[queryId]
        queryArgs = parseQuery(tg.target, substitutions)
        queryArgs.type = tg.type
        if (queryArgs.err != null)
        {
          queryError(requestId, queryArgs.err, next)
          error = true
        }
        else
        {
          // Add to the state
          queryStates.push( { pending : true } )

          // Run the query
          runAggregateQuery( requestId, queryId, req.body, db, queryArgs, res, next)
        }
      }
    }
);

app.use(auth, function(error, req, res, next)
{
  // Any request to this server will get here, and will send an HTTP
  // response with the error message
  res.status(500).json({ message: error.message });
});

// State for queries in flight. As results come it, acts as a semaphore and sends the results back
var requestIdCounter = 0
// Map of request id -> array of results. Results is
// { query, err, output }
var requestsPending = {}

// Get MongoDB connection
function getMongoURL(req){
  if (mongodb_url === null)
    return  req.header("mongodb_url")
  else
    return mongodb_url;
}

// Called when a query finishes with an error
function queryError(requestId, err, next)
{
  // We only 1 return error per query so it may have been removed from the list
  if ( requestId in requestsPending )
  {
    // Remove request
    delete requestsPending[requestId]
    // Send back error
    next(err)
  }
}

// Called when query finished
function queryFinished(requestId, queryId, results, res, next)
{
  // We only 1 return error per query so it may have been removed from the list
  let output;
  if (requestId in requestsPending) {
    let i;
    var queryStatus = requestsPending[requestId]
    // Mark this as finished
    queryStatus[queryId].pending = false
    queryStatus[queryId].results = results

    // See if we're all done
    let done = true;
    for (i = 0; i < queryStatus.length; i++) {
      if (queryStatus[i].pending == true) {
        done = false
        break
      }
    }

    // If query done, send back results
    if (done) {
      // Concatenate results
      output = []
      for (i = 0; i < queryStatus.length; i++) {
        let queryResults = queryStatus[i].results
        let keys = Object.keys(queryResults)
        for (let k = 0; k < keys.length; k++) {
          let tg = keys[k]
          output.push(queryResults[tg])
        }
      }
      res.json(output);
      next()
      // Remove request
      delete requestsPending[requestId]
    }
  }
}




function setCORSHeaders(res) 
{
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "accept, content-type");  
}

function forIn(obj, processFunc)
{
  let key;
    for (key in obj) 
    {
      let value = obj[key]
        processFunc(obj, key, value)
        if ( value != null && typeof(value) == "object") {
          forIn(value, processFunc)
        }
    }
}

function parseQuery(query, substitutions)
{
  let doc = {}
  let queryErrors = []
  let queryIndex = 3

  query = query.trim() 
  if (query.substring(0,queryIndex) !== "db.")
  {
    queryIndex = query.indexOf('.') + 1;
    doc.dbName = query.substring(0,query.indexOf('.'))
    // queryErrors.push("Query must start with db.")
    // return null
  } else {
    doc.dbName = null
  }

  // Query is of the form db.<collection>.aggregate or db.<collection>.find
  // Split on the first ( after db.
  let openBracketIndex = query.indexOf('(', 3)
  if (openBracketIndex === -1)
  {
    queryErrors.push("Can't find opening bracket")
  }
  else
  {
    // Split the first bit - it's the collection name and operation ( must be aggregate )
    let parts = query.substring(queryIndex, openBracketIndex).split('.')
    // Collection names can have .s so last part is operation, rest is the collection name
    if (parts.length >= 2)
    {
      doc.operation = parts.pop().trim()
      doc.collection = parts.join('.')       
    }
    else
    {
      queryErrors.push("Invalid collection and operation syntax")
    }
  
    // Args is the rest up to the last bracket
    let closeBracketIndex = query.indexOf(')', openBracketIndex)
    if (closeBracketIndex == -1)
    {
      queryErrors.push("Can't find last bracket")
    }
    else
    {
      let args = query.substring(openBracketIndex + 1, closeBracketIndex)
      if ( doc.operation == 'aggregate')
      {
        // Wrap args in array syntax so we can check for optional options arg
        args = '[' + args + ']'
        docs = JSON.parse(args)
        // First Arg is pipeline
        doc.pipeline = docs[0]
        // If we have 2 top level args, second is agg options
        if ( docs.length == 2 )
        {
          doc.agg_options = docs[1]
        }
        // Replace with substitutions
        for ( let i = 0; i < doc.pipeline.length; i++)
        {
          let stage = doc.pipeline[i]
            forIn(stage, function (obj, key, value)
                {
                    if ( typeof(value) == "string" )
                    {
                        if ( value in substitutions )
                        {
                            obj[key] = substitutions[value]
                        }
                    }
                })
          }
      }
      else
      {
        queryErrors.push("Unknown operation " + doc.operation + ", only aggregate supported")
      }
    }
  }
  
  if (queryErrors.length > 0 )
  {
    doc.err = new Error('Failed to parse query - ' + queryErrors.join(':'))
  }

  return doc
}

// Run an aggregate query. Must return documents of the form
// { value : 0.34334, ts : <epoch time in seconds> }

function runAggregateQuery( requestId, queryId, body, db, queryArgs, res, next )
{
  MongoClient.connect(db.url, function(err, client)
  {
    let db;
    if ( err != null )
    {
      queryError(requestId, err, next)
    }
    else
    {
      if ( queryArgs.dbName === null )
      {
        db = client.db(body.db.db);
      } else {
        db = client.db(queryArgs.dbName)
      }

  
      // Get the documents collection
      const collection = db.collection(queryArgs.collection);
      logs.logQuery(queryArgs.pipeline, queryArgs.agg_options)
      let stopwatch = new Stopwatch(true)

      collection.aggregate(queryArgs.pipeline, queryArgs.agg_options).toArray(function(err, docs) 
        {
          if ( err != null )
          {
            client.close();
            queryError(requestId, err, next)
          }
          else
          {
            try
            {
              let results = {}
              if ( queryArgs.type == 'timeserie' )
              {
                results = getTimeseriesResults(docs)
              }
              else
              {
                results = getTableResults(docs)
              }
      
              client.close();
              let elapsedTimeMs = stopwatch.stop()
              logs.logTiming(body, elapsedTimeMs)
              // Mark query as finished - will send back results when all queries finished
              queryFinished(requestId, queryId, results, res, next)
            }
            catch(err)
            {
              queryError(requestId, err, next)
            }
          }
        })
      }
    })
}

function getTableResults(docs)
{
  let columns = {}
  
  // Build superset of columns
  for ( let i = 0; i < docs.length; i++)
  {
    let doc = docs[i]
    // Go through all properties
    for (let propName in doc )
    {
      // See if we need to add a new column
      if ( !(propName in columns) )
      {
        columns[propName] = 
        {
          text : propName,
          type : "text"
        }
      }
    }
  }
  
  // Build return rows
  let rows = []
  for ( let i = 0; i < docs.length; i++)
  {
    let doc = docs[i]
    let row = []
    // All cols
    for ( let colName in columns )
    {
      let col = columns[colName]
      if ( col.text in doc )
      {
        row.push(doc[col.text])
      }
      else
      {
        row.push(null)
      }
    }
    rows.push(row)
  }
  
  let results = {}
  results["table"] = {
    columns :  Object.values(columns),
    rows : rows,
    type : "table"
  }
  return results
}

function getTimeseriesResults(docs)
{
  let results = {}
  for ( let i = 0; i < docs.length; i++)
  {
    let doc = docs[i]
    let tg = doc.name
    let dp = null
    if (tg in results)
    {
      dp = results[tg]
    }
    else
    {
      dp = { 'target' : tg, 'datapoints' : [] }
      results[tg] = dp
    }
    
    results[tg].datapoints.push([doc['value'], doc['ts'].getTime()])
  }
  return results
}

// Runs a query to support templates. Must returns documents of the form
// { _id : <id> }
function doTemplateQuery(requestId, queryArgs, db, res, next)
{
 if ( queryArgs.err == null)
  {
    // Database Name
    const dbName = db.db
    
    // Use connect method to connect to the server
    MongoClient.connect(db.url, function(err, client) 
    {
      if ( err != null )
      {
        queryError(requestId, err, next )
      }
      else
      {
        // Remove request from list
        if ( requestId in requestsPending )
        {
          delete requestsPending[requestId]
        }
        const db = client.db(dbName);
        // Get the documents collection
        const collection = db.collection(queryArgs.collection);
          
        collection.aggregate(queryArgs.pipeline).toArray(function(err, result) 
          {
            assert.equal(err, null)
    
            let output = []
            for ( let i = 0; i < result.length; i++)
            {
              let doc = result[i]
              output.push(doc["_id"])
            }
            res.json(output);
            client.close()
            next()
          })
      }
    })
  }
  else
  {
    next(queryArgs.err)
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

function getBucketCount(from, to, intervalMs)
{
  let boundaries = []
  let current = new Date(from).getTime()
  let toMs = new Date(to).getTime()
  let count = 0
  while ( current < toMs )
  {
    current += intervalMs
    count++
  }

  return count
}