process
  .on('SIGTERM', shutdown)
  .on('SIGQUIT', shutdown)
  .on('SIGINT', shutdown)
  .on('uncaughtException', function (error) {
    console.error(error)
    shutdown()
  })

var Busboy = require('busboy')
var crypto = require('crypto')
var doNotCache = require('do-not-cache')
var fs = require('fs')
var http = require('http')
var jsonfile = require('jsonfile')
var mkdirp = require('mkdirp')
var mustache = require('mustache')
var path = require('path')

var DIRECTORY = process.env.DIRECTORY || 'vote'

var server = http.createServer(function (request, response) {
  var url = request.url
  if (url === '/') return index(request, response)
  var match = /^\/([a-f0-9]{64})$/.exec(url)
  if (match) vote(request, response, match[1])
  else notFound(request, response)
})

function index (request, response) {
  var method = request.method
  if (method === 'GET') getIndex(request, response)
  else if (method === 'POST') postIndex(request, response)
  else methodNotAllowed(request, response)
}

function getIndex (request, response) {
  return fs
    .createReadStream(path.join(__dirname, 'index.html'))
    .pipe(response)
}

function postIndex (request, response) {
  var title
  var choices = []
  request.pipe(
    new Busboy({headers: request.headers})
      .on('field', function (name, value) {
        if (name === 'title') title = value
        if (name === 'choices[]') choices.push(value)
      })
      .once('finish', function () {
        createID(function (error, id) {
          if (error) return internalError(request, response, error)
          var date = dateString()
          var data = {date, title, choices}
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
  fs.readFile(
    path.join(__dirname, 'vote.html'),
    'utf8',
    function (error, template) {
      if (error) return internalError(request, response, error)
      readVoteData(id, function (error, data) {
        if (error) return internalError(request, response, error)
        response.end(mustache.render(template, data))
      })
    }
  )
}

function postVote (request, response, id) {
  doNotCache(response)
  var responder
  var choices = []
  request.pipe(new Busboy({headers: request.headers})
    .on('field', function (name, value) {
      if (name === 'responder') responder = value
      if (name === 'choices[]') choices.push(value)
    })
    .once('finish', function () {
      var date = dateString()
      var line = JSON.stringify([date, responder, choices])
      var responsesPath = joinResponsesPath(id)
      fs.appendFile(responsesPath, line + '\n', function (error) {
        if (error) return internalError(request, response, error)
        fs.createReadStream(path.join(__dirname, 'voted.html'))
          .pipe(response)
      })
    }))
}

function readVoteData (id, callback) {
  var votePath = joinVotePath(id)
  var responsesPath = joinResponsesPath(id)
  jsonfile.readFile(votePath, function (error, vote) {
    if (error) return callback(error)
    fs.readFile(responsesPath, 'utf8', function (error, ndjson) {
      if (error) {
        if (error.code === 'ENOENT') ndjson = ''
        else callback(error)
      }
      callback(null, {
        title: vote.title,
        choices: vote.choices,
        responses: ndjson
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

server.listen(process.env.PORT || 8080, function () {
  console.log('Listening on port ' + this.address().port)
})

function dateString () {
  return new Date().toISOString()
}
