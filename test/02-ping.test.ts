import * as fs from 'node:fs'

import { createPinger } from '../src/index'

describe('Ping Test', () => {
  for (const [ type, addr ] of [ [ 'IPv4', '127.0.0.1' ], [ 'IPv6', '::1' ] ]) {
    it(`should ping localhost over ${type} (${addr})`, async () => {
      const pinger = await createPinger(`${addr}`, { interval: 100 })
      try {
        expect(pinger.stats()).toEqual({
          sent: 0,
          received: 0,
          latency: NaN,
        })

        expect(pinger.closed).toBeFalse()
        expect(pinger.running).toBeFalse()

        pinger.start()
        await new Promise((resolve) => setTimeout(resolve, 1000))

        expect(pinger.closed).toBeFalse()
        expect(pinger.running).toBeTrue()

        pinger.start()
        expect(pinger.closed).toBeFalse()
        expect(pinger.running).toBeTrue()

        pinger.stop()

        expect(pinger.closed).toBeFalse()
        expect(pinger.running).toBeFalse()

        await new Promise((resolve) => setTimeout(resolve, 200))

        const stats = pinger.stats()

        expect(pinger.stats()).toEqual({
          sent: 0,
          received: 0,
          latency: NaN,
        })

        const { sent, received, latency } = stats

        expect(sent).withContext('sent').toBeGreaterThanOrEqual(9)
        expect(sent).withContext('sent').toBeLessThanOrEqual(10)
        expect(received).withContext('received').toEqual(sent)
        expect(latency).withContext('pong').toBeLessThan(10)

        expect(stats).toEqual({ sent, received, latency })
      } finally {
        await pinger.close()
      }
    })
  }

  it('should ping a real host over the network', async () => {
    const pinger = await createPinger('1.1.1.1', { interval: 100 })
    try {
      pinger.start()

      let incoming: number = 0
      let total: number = 0

      pinger.on('pong', (ms: number) => {
        incoming += 1
        total += ms
      })

      await new Promise((resolve) => setTimeout(resolve, 1000))
      await pinger.close()

      const { sent, received, latency } = pinger.stats()
      expect(sent).toBeGreaterThan(8)
      expect(received).toBeGreaterThan(1)
      expect(latency).toBeGreaterThan(1)
      expect(latency).toBeLessThan(1000)

      expect(incoming).toEqual(received)
      expect(total / incoming).toBeCloseTo(latency, 1)
    } finally {
      await pinger.close()
    }
  })

  it('should immediately close on error', async () => {
    const pinger = await createPinger('127.0.0.1', { interval: 100 })
    try {
      // await for our file descriptor to be open, socket to be bound and close
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect((<any> pinger).__fd).toBeInstanceOf(Number)
      expect((<any> pinger).__fd).toBeGreaterThan(0)
      fs.closeSync((<any> pinger).__fd)

      let error: any = undefined
      pinger.on('error', (err) => error = err)

      pinger.start()

      expect(pinger.closed).toBeFalse()
      expect(pinger.running).toBeTrue()

      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(error).toBeInstanceOf(Error)
      expect(error.code).toEqual('EBADF')

      expect(pinger.closed).toBeTrue()
      expect(pinger.running).toBeFalse()
    } finally {
      await pinger.close()
    }
  })

  it('should immediately close on error when pinging manually', async () => {
    const pinger = await createPinger('127.0.0.1')
    try {
      // await for our file descriptor to be open, socket to be bound and close
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect((<any> pinger).__fd).toBeInstanceOf(Number)
      expect((<any> pinger).__fd).toBeGreaterThan(0)
      fs.closeSync((<any> pinger).__fd)

      expect(pinger.closed).toBeFalse()
      expect(pinger.running).toBeFalse()

      await expectAsync(pinger.ping()).toBeRejectedWith(jasmine.objectContaining({
        code: 'EBADF',
      }))

      expect(pinger.closed).toBeTrue()
      expect(pinger.running).toBeFalse()
    } finally {
      await pinger.close()
    }
  })


  it('should not start when the socket is closed', async () => {
    const pinger = await createPinger('127.0.0.1', { interval: 100 })
    try {
      expect(pinger.closed).toBeFalse()
      expect(pinger.running).toBeFalse()

      await pinger.close()

      expect(pinger.closed).toBeTrue()
      expect(pinger.running).toBeFalse()

      expect(() => pinger.start()).toThrowError('Socket closed')

      await pinger.close() // should not crash / throw on second close()

      expect(pinger.closed).toBeTrue()
      expect(pinger.running).toBeFalse()
    } finally {
      await pinger.close()
    }
  })

  it('should emit warnings when the wrong packet is received', async () => {
    const pinger = await createPinger('127.0.0.1')

    const warnings: string[][] = []
    pinger.on('warning', (...args) => warnings.push(args))

    // first ping
    await pinger.ping()

    // mess up whe sequence number in the protocol handler
    ;((<any> pinger).__handler.__seq_out --)

    // ping once again, we should get ERR_SEQUENCE_TOO_SMALL
    await pinger.ping()

    // give it a jiffy to do stuff on the network
    await new Promise((resolve) => setTimeout(resolve, 100))

    // check we got our code
    expect(warnings).toEqual(jasmine.arrayContaining([
      jasmine.arrayWithExactContents([
        'ERR_SEQUENCE_TOO_SMALL',
        'Received packet with sequence in the past (duplicate packet?)',
      ]),
    ]))
  })
})
