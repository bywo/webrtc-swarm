var SimplePeer = require('simple-peer')
var inherits = require('inherits')
var events = require('events')
var through = require('through2')
var cuid = require('cuid')
var once = require('once')
var debug = require('debug')('webrtc-swarm')
var debug_heartbeat = require('debug')('webrtc-swarm:heartbeat')

module.exports = WebRTCSwarm

GIVEUP_TIMEOUT = 8 * 1000
var connectSetTimeout;

function WebRTCSwarm (hub, opts) {
  if (!(this instanceof WebRTCSwarm)) return new WebRTCSwarm(hub, opts)
  if (!hub) throw new Error('SignalHub instance required')
  if (!opts) opts = {}

  events.EventEmitter.call(this)
  this.setMaxListeners(0)

  this.hub = hub
  this.wrtc = opts.wrtc
  this.channelConfig = opts.channelConfig
  this.config = opts.config
  this.stream = opts.stream
  this.wrap = opts.wrap || function (data) { return data }
  this.unwrap = opts.unwrap || function (data) { return data }
  this.offerConstraints = opts.offerConstraints || {}
  this.maxPeers = opts.maxPeers || Infinity
  this.giveupTimeout = opts.giveupTimeout || GIVEUP_TIMEOUT
  this.me = opts.uuid || cuid()
  debug('my uuid:', this.me)

  this.remotes = {}
  this.peers = []
  this.closed = false

  subscribe(this, hub)
}

inherits(WebRTCSwarm, events.EventEmitter)

WebRTCSwarm.WEBRTC_SUPPORT = SimplePeer.WEBRTC_SUPPORT

WebRTCSwarm.prototype.close = function (cb) {
  if (this.closed) return
  this.closed = true

  if (cb) this.once('close', cb)

  var closePeers = function () {
    var len = self.peers.length
    if (len > 0) {
      var closed = 0
      self.peers.forEach(function (peer) {
        peer.once('close', function () {
          if (++closed === len) {
            self.emit('close')
          }
        })
        process.nextTick(function () {
          peer.destroy()
        })
      })
    } else {
      self.emit('close')
    }
  }

  var self = this
  if (this.hub.opened) {
    this.hub.close(function () {
      closePeers()
    })
  } else {
    closePeers()
  }
}

function setup(swarm, peer, id) {
  peer.on('connect', function () {
    debug('connected to peer', id)
    swarm.peers.push(peer)
    swarm.emit('peer', peer, id)
    swarm.emit('connect', peer, id)
  })

  var onclose = once(function (err) {
    debug('disconnected from peer', id, err)
    if (swarm.remotes[id] === peer) delete swarm.remotes[id]
    var i = swarm.peers.indexOf(peer)
    if (i > -1) swarm.peers.splice(i, 1)
    swarm.emit('disconnect', peer, id)
    if (!swarm.closed)
      unannounce(swarm, swarm.hub, id);
  })

  var signals = []
  var sending = false

  function kick () {
    if (swarm.closed || sending || !signals.length) return
    sending = true
    var data = {from: swarm.me, signal: signals.shift()}
    data = swarm.wrap(data, id)
    swarm.hub.broadcast(id, data, function () {
      sending = false
      kick()
    })
  }

  peer.on('signal', function (sig) {
    signals.push(sig)
    kick()
  })

  peer.on('iceStateChange', (connectState, gatherState) => {
    if (connectState === 'failed') onclose('ice connection failed')
  })

  peer.on('error', onclose)
  peer.once('close', onclose)

  setTimeout(() => {
    if (swarm.remotes[id] === peer && !peer.connected) {
      debug('still not connected, giving up');
      onclose(peer)
      process.nextTick(() => peer.destroy('give-up timeout'))
    }
  }, swarm.giveupTimeout);
}

function subscribe (swarm, hub) {
  const rand = cuid().slice(-12);

  hub.subscribe('all').pipe(through.obj(function (data, enc, cb) {
    data = swarm.unwrap(data, 'all')
    if (swarm.closed || !data) return cb()

    debug_heartbeat('/all', data)
    if (data.from === swarm.me) {
      debug_heartbeat('skipping self', data.from)
      return cb()
    }

    if (data.type === 'connect') {
      if (swarm.peers.length >= swarm.maxPeers) {
        debug_heartbeat('skipping because maxPeers is met', data.from)
        return cb()
      }
      if (swarm.remotes[data.from]) {
        debug_heartbeat('skipping existing remote', data.from)
        return cb()
      }

      if (rand < data.rand) {
        // the other end should be the initiator. nudge it.
        announce(swarm, hub, rand);
        return cb()
      }

      debug('connecting to new peer (as initiator)', data.from)
      var peer = new SimplePeer({
        wrtc: swarm.wrtc,
        initiator: true,
        channelConfig: swarm.channelConfig,
        config: swarm.config,
        stream: swarm.stream,
        offerConstraints: swarm.offerConstraints
      })

      setup(swarm, peer, data.from)
      swarm.remotes[data.from] = peer
    }

    cb()
  }))

  hub.subscribe(swarm.me).once('open', connect.bind(null, swarm, hub, rand)).pipe(through.obj(function (data, enc, cb) {
    data = swarm.unwrap(data, swarm.me)
    if (swarm.closed || !data) return cb()

    debug('/me', data)

    if (data.type === 'disconnect') {
      var id = data.from, peer = swarm.remotes[id];
      if (peer) {
        delete swarm.remotes[id]
        var i = swarm.peers.indexOf(peer)
        if (i > -1) swarm.peers.splice(i, 1)
        if (!peer.destroyed) peer.destroy()
        swarm.emit('disconnect', peer, id)
      }
      return cb()
    }

    var peer = swarm.remotes[data.from]
    if (!peer) {
      if (!data.signal || data.signal.type !== 'offer') {
        debug('skipping non-offer', data)
        return cb()
      }

      debug('connecting to new peer (as not initiator)', data.from)
      peer = swarm.remotes[data.from] = new SimplePeer({
        wrtc: swarm.wrtc,
        channelConfig: swarm.channelConfig,
        config: swarm.config,
        stream: swarm.stream,
        offerConstraints: swarm.offerConstraints
      })

      setup(swarm, peer, data.from)
    }

    if (data.signal) {
      if (data.signal.candidate && data.signal.candidate.candidate === "") return cb();  // Firefox hack; https://github.com/feross/simple-peer/issues/503, https://github.com/webrtcHacks/adapter/issues/863
      debug('signalling', data.from, data.signal)
      peer.signal(data.signal)
    }
    cb()
  }))

  // announce immediately
  connect(swarm, hub, rand)
}

function announce(swarm, hub, rand, cb) {
  var data = {type: 'connect', from: swarm.me, rand}
  data = swarm.wrap(data, 'all')
  hub.broadcast('all', data, cb)
}

function unannounce(swarm, hub, to) {
  var data = {type: 'disconnect', from: swarm.me}
  data = swarm.wrap(data, to)
  hub.broadcast(to, data)
}

function connect (swarm, hub, rand) {
  if (swarm.closed || swarm.peers.length >= swarm.maxPeers) return
  announce(swarm, hub, rand, function () {
    // ensure any other connect timeout is cleared
    clearTimeout(connectSetTimeout)
    connectSetTimeout = setTimeout(connect.bind(null, swarm, hub, rand),
        Math.floor(Math.random() * 2000) + (swarm.peers.length ? 13000 : 3000))
  })
}
