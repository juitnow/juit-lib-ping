Ping library for NodeJS
=======================

Does it work?
> it _seems_ to...

Does it require `root`?
> nope!

This library simply _pings_ a host, and tracks the latency over time.

Simply construct a `Pinger` with a host name / address and `start()` it!

```typescript
const pinger = await createPinger(`${addr}`)

pinger.start()

// wait for some time... then collect stats
const stats = pinger.stats()

// `stats` will now contain
// {
//   sent: 123,     // the number of ECHO Requests sent since the last call to `stats()`
//   received: 120, // the number of ECHO Responses received since the last call to `stats()`
//   latency: 98,   // the average PING latency since the last call to `stats()`
// }

ping.close()
```

Creating a `Pinger`
-------------------

A `Pinger` instance can be created calling the asynchronous `createPinger(...)`
method. This method takes two parameters:

* `to`:
  an IPv4 or IPv6 IP address to ping, or a host name. By default host names will
  be resolved as IPv4 (`A` records), unless the `options.protocol` value is set
  to `ipv6`, in which case it will be resolved as an IPv6 (`AAAA` record).
* `options`:
  an _optional_ object containing options for the `Pinger`.

#### Options

* `protocol`: (either `ipv4` or `ipv6`)
  the protocol to use. if the `to` address is an IPv6 _address_ the protocol
  will default to `ipv6`, in all other cases it will default to `ipv4`.
* `from`:
  the IP address ping _from_; this is useful when
* `source`:
  the _interface name_ used as the _source_ of our ICMP packages.
* `timeout`: (_default:_ `30000` or 30 seconds)
  the timeout **in milliseconds** after which a packet is considered _lost_.
* `interval`: (_default:_ `1000` or 1 second)
  the interval **in milliseconds** used to ping the remote host.

The `Pinger` interface
----------------------

#### Methods

* `ping()`: that's it... send an ICMP Echo Request packet.
* `start()`: starts the `Pinger`, collecting stats and emitting events.
* `stop()`: stops the `Pinger`, but keeps the underlying socket open.
* `close()`: stops the `Pinger` and _closes_ the underlying socket.
* `stats()`: collect _and reset_ statistics.

#### Properties

* `target`: the target IP address to ping _to_.
* `from`: the source IP address used to ping _from_ or `undefined`.
* `source`: the name of the _source_ interface being used or `undefined`.
* `timeout`: the timeout in milliseconds after which a packet is considered _lost_.
* `interval`: the iterval in milliseconds at which ECHO requests are sent.
* `protocol`: the IP protocol, either `ipv4` or `ipv6`.
* `running`: whether the `Pinger` is _running_ or not.
* `closed`: whether the socket is _closed_ or not.

#### Events

* `pong(latency)`:
  when an ECHO Reply packet is received (latency is in milliseconds).
* `warning(code, message)`:
  when a warning occurred it includes an error _code_ and relative message.
* `error`:
  when an error occurred; in this case the `pinger` is automatically closed.

Command Line
------------

A _brain dead_ command line interface is also available (useful for debugging):

```bash
$ juit-ping -I lo0 127.0.0.1
```

#### Parameters

* `-4`: Force the use of IPv4/ICMPv4.
* `-6`: Force the use of IPv6/ICMPv6.
* `-I address|interface`: Address or interface name to use for pinging from
