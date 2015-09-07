var assert = require('assert')
var Nano = require('nano')
var follow = require('follow')
var _ = require('lodash')
var request = require('request')
var raven = require('raven')
var log = require('loglevel')
var Q = require('q')
var sentryEndpoint = 'https://73134a7f0b994921808bfac454af4c78:369aeb7cae02496ba255b60ad352097e@app.getsentry.com/50531'

function addTime () {
  // add timestamps to logged lines
  var originalFactory = log.methodFactory
  log.methodFactory = function (methodName, logLevel, loggerName) {
    var rawMethod = originalFactory(methodName, logLevel, loggerName)
    return function (message) {
      var timestamp = (new Date()).toISOString()
      rawMethod(timestamp + ' - ' + message)
    }
  }
}
addTime()

function withOptions (options, mocks) {
  assert(options.database, 'Nano requires a database name')
  if (!mocks) {
    mocks = {}
  }
  var db = mocks.db || new Nano(options.database)
  var configurationId = 'sense-dispatch-configuration'
  var client = new raven.Client(sentryEndpoint)

  options.debug && log.setLevel('debug')

  client.patchGlobal(function () {
    log.error('Uncaught exception, terminating')
    process.exit(1)
  })

  function captureMessage (text, options) {
    log.error(text)
    log.error(JSON.stringify(options.extra))
    client.captureMessage.apply(client, arguments)
  }
  function listenChanges (additionalOptions) {
    // the options used identify this change emitter
    var ident = JSON.stringify(additionalOptions)
    log.debug('listening for changes with options ' + ident)
    // some options are always used, i omitted them from `ident` in
    // order to make logs easier to follow
    var complete = _.defaults(additionalOptions, {
      include_docs: true,
      since: 'now',
      db: options.database
    })
    var feed = mocks.feed || new follow.Feed(complete)
    feed
      .on('change', function () {
        log.debug('change detected')
        log.debug(arguments)
      })
      .on('error', function (err) {
        var text = 'change with options ' + ident + ' found an error'
        captureMessage(text, { extra: err })
      })
      .on('retry', function (info) {
        log.debug('feed ' + ident +
                  ' will retry since ' + info.since +
                  ', after ' + info.after/1000 + ' seconds')
      })
      .on('stop', function (err) {
        var text = 'a changes feed terminated'
        captureMessage(text, { extra: err })
      })

    var events = ['confirm', 'catchup', 'wait', 'timeout']
    events.forEach(function (event) {
      feed.on(event, function () {
        log.debug('feed ' + ident + ' got ' + event + ' event')
      })
    })
    feed.follow()
    return feed
  }
  function inline (obj) {
    var path = obj.configurationDocument.inlinePath
    if (path) {
      var deferred = Q.defer()
      var id = _.get(obj.change, path)
      db.get(id, function (err, body) {
        if (err) {
          captureMessage('error inlining document ' + id, { extra: err })
          // returning the object without inlining seems the most
          // reasonable thing we can do here. anyway this will likely
          // lead to an error with templating
          deferred.resolve(obj)
        } else {
          _.set(obj.change, path, body)
          deferred.resolve(obj)
        }
      })
      return deferred.promise
    } else {
      return Q(obj)
    }
  }

  /* this is a nice place where to do some consistency check, for
   * example where to check that the Telerivet endpoint is reachable,
   * options are defined, etcetera. this would allow to spot errors
   * early during initialisation, instead of during operations */

  return {
    configurationDocument: {
      getInitial: function () {
        var deferred = Q.defer()
        db.get(configurationId, function (err, body) {
          if (err) {
            deferred.reject(err)
          } else {
            deferred.resolve(body)
          }
        })
        return deferred.promise
      },
      getChanges: function () {
        return listenChanges({
          filter: '_doc_ids',
          query_params: {
            doc_ids: JSON.stringify([configurationId])
          }
        })
      }
    },
    captureMessage: captureMessage,
    captureError: client.captureError.bind(client),
    getChanges: function () {
      return listenChanges({
        filter: '_view',
        query_params: {
          view: 'dashboard/symptomatic-followups-by-dateofvisit'
        }
      })
    },
    inline: inline,
    sendToMobile: function (message) {
      log.debug('sending ' + JSON.stringify(message))
      request({
        json: true,
        body: {
          content: message.content,
          to_number: message.to
        },
        method: 'POST',
        url: options.gateway
      }, function (error, response, body) {
        if (!error) {
          log.debug('message sent to ' + message.to)
          log.debug('response is ' + JSON.stringify(response))
        } else {
          captureMessage(error, {
            extra: {
              response: JSON.stringify(response),
              body: JSON.stringify(body)
            }
          })
        }
      })
    }
  }
}

function dispatch (obj) {
  var render = _.template(obj.configurationDocument.template)
  var content = render(obj.change)
  var outgoing = obj.configurationDocument.recipients.map(function (recipient) {
    return {
      to: recipient,
      content: content
    }
  })
  log.debug('dispatching ' + outgoing.length + ' messages')
  return outgoing
}

module.exports = {
  withOptions: withOptions,
  dispatch: dispatch,
  log: log
}
