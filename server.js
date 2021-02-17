const Busboy = require('busboy')
const basicAuth = require('basic-auth')
const crypto = require('crypto')
const doNotCache = require('do-not-cache')
const fs = require('fs')
const http = require('http')
const jsonfile = require('jsonfile')
const mustache = require('mustache')
const path = require('path')
const rimraf = require('rimraf')
const runParallel = require('run-parallel')
const runParallelLimit = require('run-parallel-limit')
const runSeries = require('run-series')
const schedule = require('node-schedule')

const DIRECTORY = process.env.DIRECTORY || 'growset'
const PASSWORD = process.env.PASSWORD || 'growset'
const USERNAME = process.env.USERNAME || 'growset'

const logger = require('pino')()
const addLogs = require('pino-http')({ logger })

process
  .on('SIGTERM', shutdown)
  .on('SIGQUIT', shutdown)
  .on('SIGINT', shutdown)
  .on('uncaughtException', function (error) {
    logger.error(error)
    shutdown()
  })

const ID_BYTES = 16

const ID_RE = new RegExp('^/([a-f0-9]{' + (ID_BYTES * 2) + '})$')

const server = http.createServer(function (request, response) {
  addLogs(request, response)
  const url = request.url
  if (url === '/') return index(request, response)
  if (url === '/styles.css') return serveStyles(request, response)
  const match = ID_RE.exec(url)
  if (match) add(request, response, match[1])
  else notFound(request, response)
})

function index (request, response) {
  doNotCache(response)
  const method = request.method
  const auth = basicAuth(request)
  if (!auth || auth.name !== USERNAME || auth.pass !== PASSWORD) {
    response.statusCode = 401
    response.setHeader('WWW-Authenticate', 'Basic realm="Grow Set"')
    return response.end()
  }
  if (method === 'GET') getIndex(request, response)
  else if (method === 'POST') postIndex(request, response)
  else methodNotAllowed(request, response)
}

function getIndex (request, response) {
  fs.readdir(DIRECTORY, function (error, entries) {
    if (error) {
      if (error.code === 'ENOENT') entries = []
      else return request.log.error(error)
    }
    runParallelLimit(entries.map(function (entry) {
      return function (done) {
        readSet(entry, function (error, data) {
          if (error) return done(error)
          data.address = '/' + entry
          done(null, data)
        })
      }
    }), CONCURRENCY_LIMIT, function (error, sets) {
      if (error) return request.log.error(error)
      sets.sort(function (a, b) {
        return b.date.localeCompare(a.date)
      })
      renderMustache('index.html', { sets }, function (error, html) {
        if (error) return internalError(request, response, error)
        response.setHeader('Content-Type', 'text/html')
        response.end(html)
      })
    })
  })
}

function postIndex (request, response) {
  let title
  request.pipe(
    new Busboy({ headers: request.headers })
      .on('field', function (name, value) {
        if (!value) return
        if (name === 'title') title = value
      })
      .once('finish', function () {
        createID(function (error, id) {
          if (error) return internalError(request, response, error)
          if (!title) {
            response.statusCode = 400
            return response.end()
          }
          const date = dateString()
          const data = { date, title }
          const setPath = joinSetPath(id)
          runSeries([
            function (done) {
              fs.mkdir(dataPath(id), { recursive: true }, done)
            },
            function (done) {
              fs.writeFile(setPath, JSON.stringify(data), 'utf8', done)
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
  crypto.randomBytes(ID_BYTES, function (error, buffer) {
    if (error) return callback(error)
    callback(null, buffer.toString('hex'))
  })
}

function serveStyles (request, response) {
  response.setHeader('Content-Type', 'text/css')
  fs.createReadStream('styles.css').pipe(response)
}

function methodNotAllowed (request, response) {
  response.statusCode = 405
  response.end()
}

function add (request, response, id) {
  const method = request.method
  if (method === 'GET') getSet(request, response, id)
  else if (method === 'POST') postSet(request, response, id)
  else methodNotAllowed(request, response)
}

function getSet (request, response, id) {
  doNotCache(response)
  readSetData(id, function (error, data) {
    if (error) {
      if (error.code === 'ENOENT') return notFound(request, response)
      else return internalError(request, response, error)
    }
    renderMustache('add.html', data, function (error, html) {
      if (error) return internalError(request, response, error)
      response.setHeader('Content-Type', 'text/html')
      response.end(html)
    })
  })
}

function postSet (request, response, id) {
  doNotCache(response)
  let element
  request.pipe(new Busboy({ headers: request.headers })
    .on('field', function (name, value) {
      if (!value) return
      if (name === 'element') element = value
    })
    .once('finish', function () {
      const date = dateString()
      const line = JSON.stringify([date, element])
      const responsesPath = joinElementsPath(id)
      fs.appendFile(responsesPath, line + '\n', function (error) {
        if (error) return internalError(request, response, error)
        response.statusCode = 303
        response.setHeader('Location', '/' + id)
        response.end()
      })
    }))
}

function readSet (id, callback) {
  jsonfile.readFile(joinSetPath(id), callback)
}

function readSetData (id, callback) {
  runParallel({
    set: function (done) {
      readSet(id, done)
    },
    elements: function (done) {
      const elementsPath = joinElementsPath(id)
      fs.readFile(elementsPath, 'utf8', function (error, ndjson) {
        if (error) {
          if (error.code === 'ENOENT') ndjson = ''
          else return callback(error)
        }
        done(null, ndjson
          .split('\n')
          .map(function (line) {
            let data
            try {
              data = JSON.parse(line)
            } catch (error) {
              return null
            }
            return {
              date: data[0],
              element: data[1]
            }
          })
          .filter(function (x) {
            return x !== null
          })
          .sort(function (a, b) {
            return a.element
              .toLowerCase()
              .localeCompare(b.element.toLowerCase())
          })
        )
      })
    }
  }, function (error, results) {
    if (error) return callback(error)
    callback(null, {
      title: results.set.title,
      date: results.set.date,
      elements: results.elements
    })
  })
}

function joinElementsPath (id) {
  return path.join(dataPath(id), 'elements.ndjson')
}

function joinSetPath (id) {
  return path.join(dataPath(id), 'set.json')
}

function notFound (request, response) {
  response.statusCode = 404
  response.end('Not found.')
}

function internalError (request, response, error) {
  request.log.error(error)
  response.statusCode = 500
  response.end()
}

function shutdown () {
  server.close(function () {
    process.exit()
  })
}

server.listen(process.env.PORT || 8080)

const CONCURRENCY_LIMIT = 3

schedule.scheduleJob('0 * * * *', deleteOldSets)

deleteOldSets()

function deleteOldSets () {
  fs.readdir(DIRECTORY, function (error, entries) {
    if (error) return logger.error(error)
    runParallelLimit(entries.map(function (id) {
      return function (done) {
        const directory = path.join(DIRECTORY, id)
        const setPath = joinSetPath(id)
        jsonfile.readFile(setPath, function (error, set) {
          if (error) return logger.error(error)
          if (!old(set.date)) return
          rimraf(directory, function (error) {
            logger.info('Deleted ' + id)
            if (error) logger.error(error)
          })
        })
      }
    }), CONCURRENCY_LIMIT)
  })
}

const ONE_YEAR = 365 * 24 * 60 * 60 * 1000

function old (created) {
  return (new Date() - new Date(created)) > ONE_YEAR
}

function dateString () {
  return new Date().toISOString()
}

function renderMustache (templateFile, view, callback) {
  runParallel({
    rendered: loadFile(templateFile),
    head: loadPartial('head'),
    footer: loadPartial('footer')
  }, function (error, templates) {
    if (error) return callback(error)
    const html = mustache.render(templates.rendered, view, templates)
    callback(null, html)
  })

  function loadPartial (baseName) {
    return loadFile('_' + baseName + '.html')
  }

  function loadFile (name) {
    return function (done) {
      fs.readFile(packagePath(name), 'utf8', done)
    }
  }
}

function dataPath (fileName) {
  return path.join(DIRECTORY, fileName)
}

function packagePath (fileName) {
  return path.join(__dirname, fileName)
}
