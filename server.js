var Busboy = require('busboy')
var FormData = require('form-data')
var assert = require('assert')
var basicAuth = require('basic-auth')
var crypto = require('crypto')
var doNotCache = require('do-not-cache')
var fs = require('fs')
var http = require('http')
var https = require('https')
var jsonfile = require('jsonfile')
var mkdirp = require('mkdirp')
var mustache = require('mustache')
var os = require('os')
var path = require('path')
var rimraf = require('rimraf')
var runParallel = require('run-parallel')
var runParallelLimit = require('run-parallel-limit')
var runSeries = require('run-series')
var schedule = require('node-schedule')
var simpleConcat = require('simple-concat')

var DIRECTORY = process.env.DIRECTORY || 'vote-data'
var USER = process.env.PASSWORD || 'vote'
var PASSWORD = process.env.PASSWORD || 'vote'
var HOSTNAME = process.env.HOSTNAME || os.hostname()

process
  .on('SIGTERM', shutdown)
  .on('SIGQUIT', shutdown)
  .on('SIGINT', shutdown)
  .on('uncaughtException', function (error) {
    console.error(error)
    shutdown()
  })

var server = http.createServer(function (request, response) {
  var url = request.url
  if (url === '/') return index(request, response)
  if (url === '/styles.css') return styles(request, response)
  if (url === '/client.js') return client(request, response)
  var match = /^\/([a-f0-9]{32})$/.exec(url)
  if (match) vote(request, response, match[1])
  else notFound(request, response)
})

function index (request, response) {
  doNotCache(response)
  var method = request.method
  var auth = basicAuth(request)
  if (!auth || auth.name !== USER || auth.pass !== PASSWORD) {
    response.statusCode = 401
    response.setHeader('WWW-Authenticate', 'Basic realm="Vote"')
    return response.end()
  }
  if (method === 'GET') getIndex(request, response)
  else if (method === 'POST') postIndex(request, response)
  else methodNotAllowed(request, response)
}

function getIndex (request, response) {
  renderMustache('index.html', {}, function (error, html) {
    if (error) return internalError(request, response, error)
    response.end(html)
  })
}

function postIndex (request, response) {
  var title
  var choices = []
  request.pipe(
    new Busboy({ headers: request.headers })
      .on('field', function (name, value) {
        if (name === 'title' && value) title = value
        if (name === 'choices[]' && value) choices.push(value)
      })
      .once('finish', function () {
        createID(function (error, id) {
          if (error) return internalError(request, response, error)
          if (!title || choices.length === 0) {
            response.statusCode = 400
            return response.end()
          }
          var date = dateString()
          var data = { date, title, choices }
          var votePath = joinVotePath(id)
          runSeries([
            function (done) {
              mkdirp(dataPath(id), done)
            },
            function (done) {
              fs.writeFile(votePath, JSON.stringify(data), 'utf8', done)
            }
          ], function (error) {
            if (error) return internalError(request, response, error)
            response.setHeader('Location', '/' + id)
            response.statusCode = 303
            response.end()
          })
        })
      })
  )
}

function createID (callback) {
  crypto.randomBytes(16, function (error, buffer) {
    if (error) callback(error)
    else callback(null, buffer.toString('hex'))
  })
}

function styles (request, response) {
  fs.createReadStream(packagePath('styles.css'))
    .pipe(response)
}

function client (request, response) {
  fs.createReadStream(packagePath('client.js'))
    .pipe(response)
}

function vote (request, response, id) {
  var method = request.method
  if (method === 'GET') getVote(request, response, id)
  else if (method === 'POST') postVote(request, response, id)
  else methodNotAllowed(request, response)
}

function methodNotAllowed (request, response) {
  response.statusCode = 405
  response.end()
}

function getVote (request, response, id) {
  doNotCache(response)
  readVoteData(id, function (error, data) {
    if (error) return internalError(request, response, error)
    renderMustache('vote.html', data, function (error, html) {
      if (error) internalError(request, response, error)
      else response.end(html)
    })
  })
}

function postVote (request, response, id) {
  doNotCache(response)
  var responder
  var choices = []
  request.pipe(new Busboy({ headers: request.headers })
    .on('field', function (name, value) {
      if (name === 'responder' && value) responder = value
      if (name === 'choices[]' && value) choices.push(value)
    })
    .once('finish', function () {
      var date = dateString()
      var line = JSON.stringify([date, responder, choices])
      var responsesPath = joinResponsesPath(id)
      fs.appendFile(responsesPath, line + '\n', function (error) {
        if (error) return internalError(request, response, error)
        renderMustache('voted.html', {}, function (error, html) {
          if (error) return internalError(request, response, error)
          response.end(html)
        })
        readVoteData(id, function (error, data) {
          if (error) return console.error(error)
          var title = data.title
          mail({
            subject: 'Response to "' + title + '"',
            text: [
              '"' + responder + '" responded to ' +
              '"' + title + '".',
              HOSTNAME + '/' + id
            ]
          }, function (error) {
            if (error) console.error(error)
          })
        })
      })
    }))
}

function readVoteData (id, callback) {
  runParallel({
    vote: function (done) {
      jsonfile.readFile(joinVotePath(id), done)
    },
    ndjson: function (done) {
      var responsesPath = joinResponsesPath(id)
      fs.readFile(responsesPath, 'utf8', function (error, ndjson) {
        if (error) {
          if (error.code === 'ENOENT') ndjson = ''
          else return callback(error)
        }
        done(null, ndjson)
      })
    }
  }, function (error, results) {
    if (error) callback(error)
    callback(null, {
      title: results.vote.title,
      choices: results.vote.choices,
      responses: results.ndjson
        .split('\n')
        .map(function (line) {
          try {
            var data = JSON.parse(line)
          } catch (error) {
            return null
          }
          return {
            date: data[0],
            responder: data[1],
            choices: data[2]
          }
        })
        .filter(function (x) {
          return x !== null
        })
    })
  })
}

function joinResponsesPath (id) {
  return path.join(dataPath(id), 'responses.ndjson')
}

function joinVotePath (id) {
  return path.join(dataPath(id), 'vote.json')
}

function notFound (request, response) {
  response.statusCode = 404
  response.end('Not found.')
}

function internalError (request, response, error) {
  console.error(error)
  response.statusCode = 500
  response.end()
}

function shutdown () {
  server.close(function () {
    process.exit()
  })
}

server.listen(process.env.PORT || 8080)

var CONCURRENCY_LIMIT = 3

schedule.scheduleJob('0 * * * *', deleteOldVotes)

deleteOldVotes()

function deleteOldVotes () {
  fs.readdir(DIRECTORY, function (error, entries) {
    if (error) return console.error(error)
    runParallelLimit(entries.map(function (id) {
      return function (done) {
        var directory = path.join(DIRECTORY, id)
        var votePath = joinVotePath(id)
        jsonfile.readFile(votePath, function (error, vote) {
          if (error) return console.error(error)
          if (!old(vote.date)) return
          rimraf(directory, function (error) {
            console.log('Deleted ' + id)
            if (error) console.error(error)
          })
        })
      }
    }), CONCURRENCY_LIMIT)
  })
}

var THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000

function old (created) {
  return (new Date() - new Date(created)) > THIRTY_DAYS
}

function dateString () {
  return new Date().toISOString()
}

function mail (message, callback) {
  assert(typeof message.subject === 'string')
  assert(Array.isArray(message.text))
  assert(message.text.every(function (element) {
    return typeof element === 'string'
  }))
  assert(typeof callback === 'function')
  if (
    !process.env.MAILGUN_FROM ||
    !process.env.EMAIL_TO ||
    !process.env.MAILGUN_DOMAIN ||
    !process.env.MAILGUN_KEY
  ) {
    return callback()
  }
  var form = new FormData()
  form.append('from', process.env.MAILGUN_FROM)
  form.append('to', process.env.EMAIL_TO)
  form.append('subject', message.subject)
  form.append('o:dkim', 'yes')
  form.append('text', message.text.join('\n\n'))
  var options = {
    method: 'POST',
    host: 'api.mailgun.net',
    path: '/v3/' + process.env.MAILGUN_DOMAIN + '/messages',
    auth: 'api:' + process.env.MAILGUN_KEY,
    headers: form.getHeaders()
  }
  form.pipe(
    https.request(options)
      .once('error', function (error) {
        callback(error)
      })
      .once('response', function (response) {
        var status = response.statusCode
        if (status === 200) return callback()
        simpleConcat(response, function (error, body) {
          if (error) return callback(error)
          callback(body.toString())
        })
      })
  )
}

function renderMustache (templateFile, view, callback) {
  runParallel({
    rendered: function (done) {
      fs.readFile(packagePath(templateFile), 'utf8', done)
    },
    head: loadPartial('head'),
    footer: loadPartial('footer')
  }, function (error, templates) {
    if (error) return callback(Error)
    var html = mustache.render(templates.rendered, view, templates)
    callback(null, html)
  })
  function loadPartial (baseName) {
    return function (done) {
      fs.readFile(packagePath('_' + baseName + '.html'), 'utf8', done)
    }
  }
}

function dataPath (fileName) {
  return path.join(DIRECTORY, fileName)
}

function packagePath (fileName) {
  return path.join(__dirname, fileName)
}
