'use strict'

var mqemitter = require('mqemitter')
var EE = require('events').EventEmitter
var util = require('util')
var memory = require('aedes-persistence')
var parallel = require('fastparallel')
var series = require('fastseries')
var shortid = require('shortid')
var Packet = require('aedes-packet')
var bulk = require('bulk-write-stream')
var reusify = require('reusify')
var Client = require('./lib/client')
var xtend = require('xtend')

module.exports = Aedes

var defaultOptions = {
  concurrency: 100,
  heartbeatInterval: 60000, // 1 minute
  connectTimeout: 30000, // 30 secs
  authenticate: defaultAuthenticate,
  authorizePublish: defaultAuthorizePublish,
  authorizeSubscribe: defaultAuthorizeSubscribe,
  authorizeForward: defaultAuthorizeForward,
  published: defaultPublished
}

function Aedes (opts) {
  var that = this

  if (!(this instanceof Aedes)) {
    return new Aedes(opts)
  }

  opts = xtend(defaultOptions, opts)

  this.id = shortid()
  this.counter = 0
  this.connectTimeout = opts.connectTimeout
  this.mq = opts.mq || mqemitter(opts)
  this.handle = function handle (conn) {
    conn.setMaxListeners(opts.concurrency * 2)
    // return, just to please standard
    return new Client(that, conn)
  }
  this.persistence = opts.persistence || memory()
  this.persistence.broker = this
  this._parallel = parallel()
  this._series = series()
  this._enqueuers = reusify(DoEnqueues)

  this.authenticate = opts.authenticate
  this.authorizePublish = opts.authorizePublish
  this.authorizeSubscribe = opts.authorizeSubscribe
  this.authorizeForward = opts.authorizeForward
  this.published = opts.published

  this.clients = {}
  this.brokers = {}

  var heartbeatTopic = '$SYS/' + that.id + '/heartbeat'
  this._heartbeatInterval = setInterval(heartbeat, opts.heartbeatInterval)

  var bufId = new Buffer(that.id, 'utf8')

  function heartbeat () {
    that.publish({
      topic: heartbeatTopic,
      payload: bufId
    }, noop)
  }

  function deleteOldBrokers (broker) {
    if (that.brokers[broker] + 3 * opts.heartbeatInterval < Date.now()) {
      delete that.brokers[broker]
    }
  }

  this._clearWillInterval = setInterval(function () {
    Object.keys(that.brokers).forEach(deleteOldBrokers)

    that.persistence
      .streamWill(that.brokers)
      .pipe(bulk.obj(receiveWills))
  }, opts.heartbeatInterval * 4)

  function receiveWills (chunks, done) {
    that._parallel(that, checkAndPublish, chunks, done)
  }

  function checkAndPublish (will, done) {
    var needsPublishing =
      !that.brokers[will.brokerId] ||
      that.brokers[will.brokerId] + 3 * opts.heartbeatInterval <
      Date.now()

    if (needsPublishing) {
      // randomize this, so that multiple brokers
      // do not publish the same wills at the same time
      that.publish(will, function publishWill (err) {
        if (err) {
          return done(err)
        }

        that.persistence.delWill({
          id: will.clientId
        }, done)
      })
    } else {
      done()
    }
  }

  this.mq.on('$SYS/+/heartbeat', function storeBroker (packet, done) {
    that.brokers[packet.payload.toString()] = Date.now()
    done()
  })

  this.mq.on('$SYS/+/new/clients', function closeSameClients (packet, done) {
    var serverId = packet.topic.split('/')[1]
    var clientId = packet.payload.toString()

    if (that.clients[clientId] && serverId !== that.id) {
      that.clients[clientId].close(done)
    } else {
      done()
    }
  })

  // metadata
  this.connectedClients = 0
}

util.inherits(Aedes, EE)

function storeRetained (_, done) {
  var packet = this.packet
  if (packet.retain) {
    this.broker.persistence.storeRetained(packet, done)
  } else {
    done()
  }
}

function emitPacket (_, done) {
  this.broker.mq.emit(this.packet, done)
}

function enqueueOffline (_, done) {
  var packet = this.packet

  var enqueuer = this.broker._enqueuers.get()

  enqueuer.complete = done
  enqueuer.status = this
  enqueuer.topic = packet.topic

  this.broker.persistence.subscriptionsByTopic(
    packet.topic,
    enqueuer.done
  )
}

function DoEnqueues () {
  this.next = null
  this.status = null
  this.complete = null
  this.topic = null

  var that = this

  this.done = function doneEnqueue (err, subs) {
    var status = that.status
    var broker = status.broker

    if (err) {
      // is this really recoverable?
      // let's just error the whole aedes
      broker.emit('error', err)
    } else {
      var complete = that.complete

      if (that.topic.indexOf('$SYS') === 0) {
        subs = subs.filter(removeSharp)
      }

      that.status = null
      that.complete = null
      that.topic = null

      broker._parallel(
        status,
        doEnqueue, subs, complete)

      broker._enqueuers.release(that)
    }
  }
}

function removeSharp (sub) {
  return sub.topic !== '#'
}

function doEnqueue (sub, done) {
  this.broker.persistence.outgoingEnqueue(sub, this.packet, done)
}

function callPublished (_, done) {
  this.broker.published(this.packet, this.client, done)
  this.broker.emit('publish', this.packet, this.client)
}

var publishFuncsSimple = [
  storeRetained,
  emitPacket,
  callPublished
]
var publishFuncsQoS = [
  storeRetained,
  enqueueOffline,
  emitPacket,
  callPublished
]
Aedes.prototype.publish = function (packet, client, done) {
  if (typeof client === 'function') {
    done = client
    client = null
  }
  var p = new Packet(packet, this)
  var publishFuncs = publishFuncsSimple
  if (p.qos > 0) {
    publishFuncs = publishFuncsQoS
  }
  this._series(new PublishState(this, client, p), publishFuncs, null, done)
}

Aedes.prototype.subscribe = function (topic, func, done) {
  this.mq.on(topic, func, done)
}

Aedes.prototype.unsubscribe = function (topic, func, done) {
  this.mq.removeListener(topic, func, done)
}

Aedes.prototype.registerClient = function (client) {
  var that = this
  if (this.clients[client.id]) {
    // moving out so we wait for this, so we don't
    // unregister a good client
    this.clients[client.id].close(function closeClient () {
      that._finishRegisterClient(client)
    })
  } else {
    this._finishRegisterClient(client)
  }
}

Aedes.prototype._finishRegisterClient = function (client) {
  this.connectedClients++
  this.clients[client.id] = client
  this.emit('client', client)
  this.publish({
    topic: '$SYS/' + this.id + '/new/clients',
    payload: new Buffer(client.id, 'utf8')
  }, noop)
}

Aedes.prototype.unregisterClient = function (client) {
  this.connectedClients--
  delete this.clients[client.id]
  this.emit('clientDisconnect', client)
}

function closeClient (client, cb) {
  this.clients[client].close(cb)
}

Aedes.prototype.close = function (cb) {
  clearInterval(this._heartbeatInterval)
  clearInterval(this._clearWillInterval)
  this._parallel(this, closeClient, Object.keys(this.clients), cb || noop)
}

function defaultAuthenticate (client, username, password, callback) {
  callback(null, true)
}

function defaultAuthorizePublish (client, packet, callback) {
  callback(null)
}

function defaultAuthorizeSubscribe (client, sub, callback) {
  callback(null, sub)
}

function defaultAuthorizeForward (client, packet) {
  return packet
}

function defaultPublished (packet, client, callback) {
  callback(null)
}

function PublishState (broker, client, packet) {
  this.broker = broker
  this.client = client
  this.packet = packet
}

function noop () {}
