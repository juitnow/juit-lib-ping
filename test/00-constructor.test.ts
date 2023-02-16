import { AssertionError } from 'node:assert'
import { resolve4, resolve6 } from 'node:dns/promises'
import { networkInterfaces } from 'node:os'

import { createPinger } from '../src/index'

import type { Pinger } from '../src/index'

describe('Constructor', () => {
  let pinger: Pinger | void

  let localIf4: string = ''
  let localIf6: string = ''

  beforeAll(() => {
    for (const [ name, infos ] of Object.entries(networkInterfaces())) {
      for (const info of infos || []) {
        if (info.address === '127.0.0.1') {
          localIf4 = name
        } else if (info.address === '::1') {
          localIf6 = name
        }
      }
    }

    expect(localIf4).toBeTruthy()
    expect(localIf6).toBeTruthy()
  })

  afterEach(async () => {
    if (pinger) pinger = await pinger.close()
  })

  it('should construct with an IPv4 address', async () => {
    pinger = await createPinger('127.0.0.1')

    expect(pinger).toEqual(jasmine.objectContaining({
      from: undefined,
      source: undefined,
      target: '127.0.0.1',
      timeout: 30000,
      interval: 1000,
      protocol: 'ipv4',
    }))
  })

  it('should construct with an IPv6 address', async () => {
    pinger = await createPinger('::1')

    expect(pinger).toEqual(jasmine.objectContaining({
      from: undefined,
      source: undefined,
      target: '::1',
      timeout: 30000,
      interval: 1000,
      protocol: 'ipv6',
    }))
  })

  it('should construct with an IPv4 host name', async () => {
    const addr = (await resolve4('www.google.com'))[0]
    expect(addr).toBeTruthy()

    pinger = await createPinger('www.google.com', { protocol: 'ipv4' })
    expect(pinger).toEqual(jasmine.objectContaining({
      from: undefined,
      source: undefined,
      target: addr,
      timeout: 30000,
      interval: 1000,
      protocol: 'ipv4',
    }))
  })

  it('should construct with an IPv6 host name', async () => {
    const addr = (await resolve6('www.google.com'))[0]
    expect(addr).toBeTruthy()

    pinger = await createPinger('www.google.com', { protocol: 'ipv6' })
    expect(pinger).toEqual(jasmine.objectContaining({
      from: undefined,
      source: undefined,
      target: addr,
      timeout: 30000,
      interval: 1000,
      protocol: 'ipv6',
    }))
  })

  it('should construct with an IPv4 from address and target', async () => {
    pinger = await createPinger('127.0.0.1', { from: '127.0.0.1' })

    expect(pinger).toEqual(jasmine.objectContaining({
      from: '127.0.0.1',
      source: undefined,
      target: '127.0.0.1',
      timeout: 30000,
      interval: 1000,
      protocol: 'ipv4',
    }))
  })

  it('should construct with an IPv6 from address and target', async () => {
    pinger = await createPinger('::1', { from: '::1' })

    expect(pinger).toEqual(jasmine.objectContaining({
      from: '::1',
      source: undefined,
      target: '::1',
      timeout: 30000,
      interval: 1000,
      protocol: 'ipv6',
    }))
  })

  it('should construct with an IPv4 source interface and target', async () => {
    pinger = await createPinger('127.0.0.1', { source: localIf4 })

    expect(pinger).toEqual(jasmine.objectContaining({
      from: undefined,
      source: localIf4,
      target: '127.0.0.1',
      timeout: 30000,
      interval: 1000,
      protocol: 'ipv4',
    }))
  })

  it('should construct with an IPv6 source interface and target', async () => {
    pinger = await createPinger('::1', { source: localIf6 })

    expect(pinger).toEqual(jasmine.objectContaining({
      from: undefined,
      source: localIf6,
      target: '::1',
      timeout: 30000,
      interval: 1000,
      protocol: 'ipv6',
    }))
  })

  /* ======================================================================== */

  it('should not construct with the wrong protocol', async () => {
    await expectAsync(createPinger('::1', { protocol: 0 } as any))
        .toBeRejectedWithError(AssertionError, 'Invalid protocol "0" specified')
  })

  it('should not construct with a wrong host name', async () => {
    await expectAsync(createPinger('no-wrong.juit.com'))
        .toBeRejectedWithError(Error, 'Unable to resolve ping target "no-wrong.juit.com" as an ipv4 address')
    await expectAsync(createPinger('no-wrong.juit.com', { protocol: 'ipv4' }))
        .toBeRejectedWithError(Error, 'Unable to resolve ping target "no-wrong.juit.com" as an ipv4 address')
    await expectAsync(createPinger('no-wrong.juit.com', { protocol: 'ipv6' }))
        .toBeRejectedWithError(Error, 'Unable to resolve ping target "no-wrong.juit.com" as an ipv6 address')
  })

  it('should not construct when an address does not match the protocol', async () => {
    await expectAsync(createPinger('127.0.0.1', { protocol: 'ipv6' }))
        .toBeRejectedWithError(Error, 'Invalid IPv4 ping target "127.0.0.1"')
    await expectAsync(createPinger('::1', { protocol: 'ipv4' }))
        .toBeRejectedWithError(Error, 'Invalid IPv6 ping target "::1"')
  })

  it('should not construct when the from address is invalid', async () => {
    await expectAsync(createPinger('127.0.0.1', { from: 'wrong-address' }))
        .toBeRejectedWithError(Error, 'Invalid IP address to ping from "wrong-address"')
  })

  it('should not construct when the source interface is invalid', async () => {
    await expectAsync(createPinger('127.0.0.1', { source: 'wrong-interface' }))
        .toBeRejectedWithError(Error, 'Invalid source interface name "wrong-interface"')
  })

  it('should not construct when a source address does not match the target', async () => {
    await expectAsync(createPinger('127.0.0.1', { from: '::1' }))
        .toBeRejectedWithError(Error, 'Invalid IPv4 address to ping from "::1"')
    await expectAsync(createPinger('::1', { from: '127.0.0.1' }))
        .toBeRejectedWithError(Error, 'Invalid IPv6 address to ping from "127.0.0.1"')
  })

  it('should not construct when a source address does not match an interface', async () => {
    // sorry, cloudflare 1.1.1.1
    await expectAsync(createPinger('127.0.0.1', { from: '1.1.1.1' }))
        .toBeRejectedWithError(Error, 'address not available')
    await expectAsync(createPinger('::1', { from: '2606:4700:4700::1111' }))
        .toBeRejectedWithError(Error, 'address not available')
  })
})
