import assert from 'node:assert'
import { createSocket } from 'node:dgram'
import { resolve4, resolve6 } from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import { isIP, isIPv4, isIPv6 } from 'node:net'
import { networkInterfaces } from 'node:os'

import native from '../native/ping.cjs'
import { getWarning, ProtocolHandler } from './protocol'

import type { Socket } from 'node:dgram'


/** Options to create a {@link Pinger} instance */
export interface PingerOptions {
  /** The protocol: either `ipv4` or `ipv6` */
  protocol?: 'ipv4' | 'ipv6',
  /** An optional IP address or used to ping _from_ */
  from?: string,
  /** An optional source interface name to bind to for pinging */
  source?: string,
  /** The timeout **in milliseconds** after which a packet is considered _lost_ (default: 30000 - 30 sec) */
  timeout?: number,
  /** The interval **in milliseconds** used to ping the remote host (default: 1000 - 1 sec) */
  interval?: number,
}

/**
 * Asynchronously create a new {@link Pinger} instance.
 *
 * @param to The IP address or host name to ping. If this parameter is an `IPv6`
 *           _address_ (e.g. `::1`) the protocol used will default to `IPv6`
 *           otherwise it will default to `IPv4`.
 */
export async function createPinger(to: string, options: PingerOptions = {}): Promise<Pinger> {
  const {
    protocol = isIPv6(to) ? 'ipv6' : 'ipv4',
    timeout = 30000,
    interval = 1000,
    from,
    source,
  } = options

  // Determine (and check) the address family
  const family =
    protocol === 'ipv6' ? native.AF_INET6 :
    protocol === 'ipv4' ? native.AF_INET :
    undefined
  assert((family === native.AF_INET) || (family === native.AF_INET6), `Invalid protocol "${protocol}" specified`)

  // Determine (or resolve) the destination address
  const target = isIP(to) ? to :
    protocol === 'ipv6' ? (await resolve6(to).catch(() => []))[0] :
    protocol === 'ipv4' ? (await resolve4(to).catch(() => []))[0] :
    /* coverage ignore next */ undefined

  //  Check that the target was resolved and is the right kind
  if (! target) {
    throw new Error(`Unable to resolve ping target "${to}" as an ${protocol} address`)
  } else if (isIPv4(target) && (protocol != 'ipv4')) {
    throw new Error(`Invalid IPv4 ping target "${target}"`)
  } else if (isIPv6(target) && (protocol != 'ipv6')) {
    throw new Error(`Invalid IPv6 ping target "${target}"`)
  }

  // Determine the optional from address and check it's the right kind
  if (from) {
    if (isIPv4(from) && (protocol != 'ipv4')) {
      throw new Error(`Invalid IPv6 address to ping from "${from}"`)
    } else if (isIPv6(from) && (protocol != 'ipv6')) {
      throw new Error(`Invalid IPv4 address to ping from "${from}"`)
    } else if (!isIP(from)) {
      throw new Error(`Invalid IP address to ping from "${from}"`)
    }
  }

  // Ensure that the source interface is actually valid
  if ((source) && (! networkInterfaces()[source])) {
    throw new Error(`Invalid source interface name "${source}"`)
  }

  // Return a promise wrapping around our native code's "open" call
  return new Promise((resolve, reject) => {
    native.open(family, from, source, (error: Error | null, fd: number | undefined) => {
      if (error) {
        Error.captureStackTrace(error)
        return reject(error)
      } else if (fd) {
        return resolve(new PingerImpl(from, source, target, timeout, interval, protocol, fd))
      } else /* coverage ignore next */ {
        return reject(new Error(`Unknown error (fd=${fd})`))
      }
    })
  })
}

export interface Pinger {
  /** An optional IP address or used to ping _from_ */
  readonly from?: string | undefined
  /** An optional source interface name to bind to for pinging */
  readonly source?: string | undefined
  /** The IP address or host name to ping. */
  readonly target: string
  /** The timeout **in milliseconds** after which a packet is considered _lost_ (default: 30000 - 30 sec) */
  readonly timeout: number
  /** The interval **in milliseconds** used to ping the remote host (default: 1000 - 1 sec) */
  readonly interval: number
  /** The protocol: either `ipv4` or `ipv6` */
  readonly protocol: 'ipv4' | 'ipv6'

  /** A flag indicating whether this pinger is _running_ */
  readonly running: boolean
  /** A flag indicating whether this pinger was _closed_ */
  readonly closed: boolean

  start(): void
  stop(): void
  close(): Promise<void>
  stats(): PingerStats

  ping(): Promise<void>
  ping(callback: (error: Error | null) => void): void

  on(event: 'error', handler: (error: Error) => void): void
  off(event: 'error', handler: (error: Error) => void): void
  once(event: 'error', handler: (error: Error) => void): void

  on(event: 'warning', handler: (code: string, message: string) => void): void
  off(event: 'warning', handler: (code: string, message: string) => void): void
  once(event: 'warning', handler: (code: string, message: string) => void): void

  on(event: 'pong', handler: (latency: number) => void): void
  off(event: 'pong', handler: (latency: number) => void): void
  once(event: 'pong', handler: (latency: number) => void): void
}

export interface PingerStats {
  sent: number,
  received: number,
  latency: number,
}

class PingerImpl extends EventEmitter implements Pinger {
  private readonly __handler: ProtocolHandler
  private readonly __socket: Socket

  private __timer?: NodeJS.Timer

  private __sent: number = 0
  private __received: number = 0
  private __latency: bigint = 0n
  private __closed: boolean = false

  constructor(
      public readonly from: string | undefined,
      public readonly source: string | undefined,
      public readonly target: string,
      public readonly timeout: number,
      public readonly interval: number,
      public readonly protocol: 'ipv4' | 'ipv6',
      fd: number,
  ) {
    super()

    const type = protocol === 'ipv4' ? 'udp4' : 'udp6'

    this.__handler = new ProtocolHandler(protocol === 'ipv6')

    // Create a socket and handle its incoming messages
    this.__socket = createSocket({ type }, (buffer, info) => {
      // coverage ignore if
      // Check that the address we received the packet from matches our target
      if (info.address !== target) return

      // Get the latency for the incoming packet in nanoseconds (might be)
      const latency = this.__handler.incoming(buffer)
      if (latency < 0n) {
        const warning = getWarning(latency)
        this.emit('warning', warning.code, warning.message)
        return // negative latency, wrong packet!
      }

      // Notify listeners and increase counters for stats
      this.emit('pong', Number(latency) / 1000000)
      this.__latency += latency
      this.__received ++
    }).bind({ fd }, () => {
      Object.defineProperty(this, '__fd', { value: fd })
    })

    // Mark when we're closed
    this.__socket.on('close', () => this.__closed = true)
  }

  get running(): boolean {
    return !! this.__timer
  }

  get closed(): boolean {
    return this.__closed
  }

  // wrap "emit" so that "error" events won't throw when no listeners are there
  emit(eventName: 'error' | 'warning' | 'pong', ...args: any[]): boolean {
    if (this.listenerCount(eventName) < 1) return false
    return super.emit(eventName, ...args)
  }

  ping(): Promise<void>
  ping(callback: (error: Error | null) => void): void
  ping(callback?: (error: Error | null) => void): Promise<void> | void {
    if (! callback) {
      return new Promise((resolve, reject) => {
        this.ping((error: Error | null) => error ? reject(error) : resolve())
      })
    }

    const buffer = this.__handler.outgoing()
    this.__socket.send(buffer, 1, this.target, (error: any) => {
      if (error) {
        this.emit('error', error)
        void this.close()
        callback(error)
      } else {
        this.__sent ++
        callback(null)
      }
    })
  }

  start(): void {
    if (this.__closed) throw new Error('Socket closed')
    if (this.__timer) return

    this.__timer = setInterval(() => this.ping(() => void 0), this.interval).unref()
  }

  stop(): void {
    if (this.__timer) clearInterval(this.__timer)
    this.__timer = undefined
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.__closed) return resolve()
      this.__socket.close(resolve)
      this.__closed = true
      this.stop()
    })
  }

  stats(): PingerStats {
    // Latency is NaN if no packets were received
    const latency = this.__received < 1 ? NaN :
      Number(this.__latency / BigInt(this.__received)) / 1000000

    // Prepare the stats object from our counters
    const stats = { sent: this.__sent, received: this.__received, latency }

    // Reset counters
    this.__sent = 0
    this.__received = 0
    this.__latency = 0n

    // Done
    return stats
  }
}
