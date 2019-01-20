var Busboy = require('busboy')
var FormData = require('form-data')
var basicAuth = require('basic-auth')
var crypto = require('crypto')
var doNotCache = require('do-not-cache')
var fs = require('fs')
var http = require('http')
var https = require('https')
var jsonfile = require('jsonfile')
var mkdirp = require('mkdirp')
var mustache = require('mustache')
var path = require('path')
var runParallel = require('run-parallel')
var simpleConcat = require('simple-concat')

var DIRECTORY = process.env.DIRECTORY || 'vote'
var USER = process.env.PASSWORD || 'vote'
var PASSWORD = process.env.PASSWORD || 'vote'

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
  var match = /^\/([a-f0-9]{64})$/.exec(url)
  if (match) vote(request, response, match[1])
  else notFound(request, response)
})

function index (request, response) {
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
    else response.end(html)
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
          var date = dateString()
          var data = { date, title, choices }
          var votePath = joinVotePath(id)
          mkdirp(
            path.join(DIRECTORY, id),
            function (error) {
              if (error) return internalError(request, response, error)
              fs.writeFile(
                votePath,
                JSON.stringify(data),
                'utf8',
                function (error) {
                  if (error) return internalError(request, response, error)
                  response.setHeader('Location', '/' + id)
                  response.statusCode = 303
                  response.end()
                }
              )
            }
          )
        })
      })
  )
}

function createID (callback) {
  crypto.randomBytes(32, function (error, buffer) {
    if (error) callback(error)
    else callback(null, buffer.toString('hex'))
  })
}

function styles (request, response) {
  fs.createReadStream(path.join(__dirname, 'styles.css')).pipe(response)
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
          else response.end(html)
        })
        readVoteData(id, function (error, data) {
          if (error) return console.error(error)
          var title = data.title
          mail({
            subject: 'Response to "' + title + '"',
            text: [
              '"' + responder + '" responded to ' +
              '"' + title + '".',
              process.env.HOSTNAME + '/' + id
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
  return path.join(DIRECTORY, id, 'responses.ndjson')
}

function joinVotePath (id) {
  return path.join(DIRECTORY, id, 'vote.json')
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

function dateString () {
  return new Date().toISOString()
}

function mail (message, callback) {
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
      fs.readFile(path.join(__dirname, templateFile), 'utf8', done)
    },
    head: function (done) {
      fs.readFile(path.join(__dirname, 'head.html'), 'utf8', done)
    }
  }, function (error, templates) {
    if (error) return callback(Error)
    var partials = { head: templates.head }
    var html = mustache.render(templates.rendered, view, partials)
    callback(null, html)
  })
}
