import assert from 'node:assert'
import { resolve4, resolve6 } from 'node:dns/promises'
import { isIP, isIPv4, isIPv6 } from 'node:net'
import { networkInterfaces } from 'node:os'
import { createSocket } from 'node:dgram'
import { EventEmitter } from 'node:events'

import * as native from '../native/ping.cjs'
import { ProtocolHandler } from './protocol'

import type { Socket } from 'node:dgram'


function ifAddr(name: string, protocol: 'ipv4' | 'ipv6'): string | undefined {
  const infos = networkInterfaces()[name]
  if (! infos) return

  const info = infos.filter((i) => i.family.toLowerCase() === protocol)[0]
  return info?.address
}

/** Options to create a {@link Pinger} instance */
export interface PingerOptions {
  /** The protocol level: `4` for `IPv4` or `6` for `IPv6` */
  protocol?: 'ipv4' | 'ipv6',
  /** An optional address or _interface name_ used to ping _from_ */
  from?: string,
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
    from = null,
    timeout = 30000,
    interval = 1000,
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

  // Determine the optional source address and check it's the right kind
  const source = from ? (ifAddr(from, protocol) || from) : undefined
  if (source) {
    if (isIPv4(source) && (protocol != 'ipv4')) {
      throw new Error(`Invalid IPv6 ping source "${source}"`)
    } else if (isIPv6(source) && (protocol != 'ipv6')) {
      throw new Error(`Invalid IPv4 ping source "${source}"`)
    } else if (! isIP(source)) {
      throw new Error(`Invalid source interface name "${source}"`)
    }
  }

  // Return a promise wrapping around our native code's "open" call
  return new Promise((resolve, reject) => {
    native.open(family, source, (error: Error | null, fd: number | undefined) => {
      if (error) {
        Error.captureStackTrace(error)
        return reject(error)
      } else if (fd) {
        return resolve(new PingerImpl(source, target, timeout, interval, protocol, fd))
      } else /* coverage ignore next */ {
        return reject(new Error(`Unknown error (fd=${fd})`))
      }
    })
  })
}

export interface Pinger {
  readonly source?: string | undefined
  readonly target: string
  readonly timeout: number
  readonly interval: number
  readonly protocol: 'ipv4' | 'ipv6'

  readonly running: boolean
  readonly closed: boolean

  start(): void
  stop(): void
  close(): Promise<void>
  stats(): PingerStats

  on(event: 'error', handler: (error: Error) => void): void
  once(event: 'error', handler: (error: Error) => void): void
  off(event: 'error', handler: (error: Error) => void): void

  on(event: 'pong', handler: (latency: number) => void): void
  once(event: 'pong', handler: (latency: number) => void): void
  off(event: 'pong', handler: (latency: number) => void): void
}

export interface PingerStats {
  sent: number,
  received: number,
  latency: number,
}

class PingerImpl extends EventEmitter implements Pinger {
  #handler: ProtocolHandler
  #socket: Socket

  #timer?: NodeJS.Timer

  #sent: number = 0
  #received: number = 0
  #latency: bigint = 0n
  #closed: boolean = false

  constructor(
      public readonly source: string | undefined,
      public readonly target: string,
      public readonly timeout: number,
      public readonly interval: number,
      public readonly protocol: 'ipv4' | 'ipv6',
      fd: number,
  ) {
    super()

    const type = protocol === 'ipv4' ? 'udp4' : 'udp6'

    this.#handler = new ProtocolHandler(protocol === 'ipv6')

    // Create a socket and handle its incoming messages
    this.#socket = createSocket({ type }, (buffer, info) => {
      // Check that the address we received the packet from matches our target
      if (info.address !== target) return

      // Get the latency for the incoming packet in nanoseconds (might be)
      const latency = this.#handler.incoming(buffer)
      if (latency < 0n) return // negative latency, wrong packet!

      // Notify listeners and increase counters for stats
      this.emit('pong', Number(latency) / 1000000)
      this.#latency += latency
      this.#received ++
    }).bind({ fd }, () => {
      Object.defineProperty(this, '__fd', { value: fd })
    })

    // Mark when we're closed
    this.#socket.on('close', () => this.#closed = true)
  }

  get running(): boolean {
    return !! this.#timer
  }

  get closed(): boolean {
    return this.#closed
  }

  start(): void {
    if (this.#closed) throw new Error('Socket closed')
    if (this.#timer) return

    this.#timer = setInterval(() => {
      const buffer = this.#handler.outgoing()
      this.#socket.send(buffer, 1, this.target, (error: any) => {
        if (error) {
          this.emit('error', error)
          void this.close()
        } else {
          this.#sent ++
        }
      })
    }, this.interval)
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.#closed) return resolve()
      this.#socket.close(resolve)
      this.#closed = true
      this.stop()
    })
  }

  stats(): PingerStats {
    // Latency is NaN if no packets were received
    const latency = this.#received < 1 ? NaN :
      Number(this.#latency / BigInt(this.#received)) / 1000000

    // Prepare the stats object from our counters
    const stats = { sent: this.#sent, received: this.#received, latency }

    // Reset counters
    this.#sent = 0
    this.#received = 0
    this.#latency = 0n

    // Done
    return stats
  }
}
